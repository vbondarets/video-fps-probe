import { useCallback, useEffect } from 'react';
import type { FileResult, VideoTrackResult } from 'video-fps-probe';
import { bytes, count, duration, fps, ms, primaryTrack, share } from './format.ts';
import { autoCompare, registerHost, runCompare, type CompareEngine, type Row } from './store.ts';

type Column = 'own' | CompareEngine;

const LABEL: Record<Column, string> = { own: 'own parser', mp4box: 'mp4box (tuned adapter)', mediabunny: 'mediabunny (tuned adapter)', rvfc: 'rVFC' };

const METRICS: [string, (t: VideoTrackResult, r: FileResult) => string][] = [
  ['Average FPS', (t) => fps(t.avgFps)],
  ['Average (num/den)', (t) => (t.avgFps ? `${t.avgFps.num}/${t.avgFps.den}` : '-')],
  ['Frames', (t) => count(t.presentedFrames ?? t.frames)],
  ['Min FPS', (t) => fps(t.minFps)],
  ['Max FPS', (t) => fps(t.maxFps)],
  ['VFR', (t) => (t.isVfr === null ? '-' : t.isVfr ? `yes ${share(t.vfrRatio)}` : 'no')],
  ['Duration', (t, r) => duration(t.durationSec ?? r.formatDurationSec)],
];

const IO_METRICS: [string, (r: FileResult) => string][] = [
  ['Bytes read', (r) => bytes(r.io.bytesRead)],
  ['Reads', (r) => count(r.io.reads)],
  ['Time', (r) => ms(r.io.ms)],
];

function delta(own: VideoTrackResult | null, t: VideoTrackResult | null): string {
  if (!own?.avgFps || !t?.avgFps || own.avgFps.value === 0) return '-';
  const d = (t.avgFps.value / own.avgFps.value - 1) * 100;
  return `${d > 0 ? '+' : ''}${d.toFixed(3)}%`;
}

export default function Compare({ row }: { row: Row }) {
  const own = row.result!;
  const iso = own.container === 'mp4' || own.container === 'mov';
  const columns: Column[] = iso ? ['own', 'mp4box', 'mediabunny', 'rvfc'] : ['own', 'mediabunny', 'rvfc'];
  const hostRef = useCallback((el: HTMLDivElement | null) => registerHost(row.id, el), [row.id]);
  useEffect(() => autoCompare(row.id), [row.id]);

  const resultOf = (c: Column) => (c === 'own' ? own : (row.compare[c]?.result ?? null));
  const ownTrack = primaryTrack(own);
  const status = (c: Column): string => {
    if (c === 'own') return 'done';
    const run = row.compare[c];
    if (!run) return 'not run';
    if (run.busy) return run.progress && run.progress.total > 0 ? `${run.progress.phase} ${share(run.progress.done / run.progress.total)}` : 'running';
    return run.error ?? run.result?.error ?? 'done';
  };

  return (
    <div className="cmp-body">
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">
                <span className="sr">Metric</span>
              </th>
              {columns.map((c) => {
                const run = c === 'own' ? undefined : row.compare[c];
                return (
                  <th scope="col" key={c}>
                    {LABEL[c]}
                    {c !== 'own' && (
                      <button
                        type="button"
                        title={c === 'rvfc' ? 'approximate, plays the video' : undefined}
                        onClick={() => (run?.busy ? run.cancel?.() : void runCompare(row.id, c).catch(() => {}))}
                      >
                        {run?.busy ? 'Cancel' : run ? 'Re-run' : c === 'rvfc' ? 'Run (approximate)' : 'Run'}
                      </button>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Status</th>
              {columns.map((c) => (
                <td key={c} className={c !== 'own' && (row.compare[c]?.error ?? row.compare[c]?.result?.error) ? 'err' : undefined}>
                  {status(c)}
                </td>
              ))}
            </tr>
            {METRICS.map(([label, get]) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                {columns.map((c) => {
                  const r = resultOf(c);
                  const t = r && primaryTrack(r);
                  return <td key={c}>{r && t ? get(t, r) : '-'}</td>;
                })}
              </tr>
            ))}
            <tr>
              <th scope="row">Avg vs own</th>
              {columns.map((c) => {
                const r = resultOf(c);
                return <td key={c}>{c === 'own' ? '' : delta(ownTrack, r && primaryTrack(r))}</td>;
              })}
            </tr>
            {IO_METRICS.map(([label, get]) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                {columns.map((c) => {
                  const r = resultOf(c);
                  const unmeasured = c === 'rvfc' && (label !== 'Time' || !!r?.error);
                  return <td key={c}>{r && !unmeasured ? get(r) : '-'}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mut">rVFC is approximate: it plays the video in the player below and times the presented frames.</p>
      <div className="rvfc-host" ref={hostRef} />
    </div>
  );
}
