import { lazy, memo, Suspense, useState, type ReactNode } from 'react';
import { primaryTrack } from '../core/result.ts';
import type { FileResult, Provenance, VideoTrackResult } from '../core/types.ts';
import { bytes, count, duration, fps, ms, PROVENANCE, readPercent, share } from './format.ts';
import { cancelRow, rescan, type Row } from './store.ts';

const Compare = lazy(() => import('./Compare.tsx'));

const SCAN_HELP = 'header: container headers only. probe: headers plus sampled blocks. exact: every block walked.';

export function Mark({ p }: { p: Provenance }) {
  const [glyph, text] = PROVENANCE[p];
  return (
    <i className={`p p-${p}`} title={text} aria-label={p}>
      {glyph}
    </i>
  );
}

interface CellProps {
  k: string;
  p?: Provenance | undefined;
  title?: string;
  extra?: ReactNode;
  children: ReactNode;
}

function Cell({ k, p, title, extra, children }: CellProps) {
  return (
    <div className="c" title={title}>
      <dt>{k}</dt>
      <dd>
        {children}
        {p && <Mark p={p} />}
        {extra && <small> {extra}</small>}
      </dd>
    </div>
  );
}

function VfrCell({ t }: { t: VideoTrackResult }) {
  let body: ReactNode = <span className="mut">n/a</span>;
  if (t.isStill) body = <span className="mut">still image</span>;
  else if (t.isVfr) body = <span className="badge vfr" title="share of frame intervals that differ from the median">VFR {share(t.vfrRatio)}</span>;
  else if (t.isVfr === false) {
    body = <span className="badge cfr">{t.timestampsQuantized ? 'CFR, 1 ms quantized' : 'CFR'}</span>;
  }
  return (
    <Cell k="Frame timing" p={t.provenance.isVfr}>
      {body}
    </Cell>
  );
}

function TrackCells({ t, r }: { t: VideoTrackResult; r: FileResult }) {
  const p = t.provenance;
  const frames = t.presentedFrames ?? t.frames;
  const nominal = t.nominalFps;
  const dominant = t.dominantFps;
  const stored = t.frames !== null && t.presentedFrames !== null && t.frames !== t.presentedFrames;
  return (
    <>
      <Cell k="Codec" p={p.codec}>
        {t.codecName || t.fourccOrCodecId || '-'}
      </Cell>
      <Cell k="Size" p={p.dimensions} extra={t.rotation ? `rot ${t.rotation}°` : null}>
        {t.width && t.height ? `${t.width}x${t.height}` : '-'}
      </Cell>
      <Cell k="Duration" p={p.durationSec}>
        {duration(t.durationSec ?? r.formatDurationSec)}
      </Cell>
      <Cell k="Frames" p={p.presentedFrames ?? p.frames} extra={stored ? `stored ${count(t.frames)}` : null}>
        {count(frames)}
      </Cell>
      <Cell k="Average FPS" p={p.avgFps} extra={t.avgFpsFfprobe && <span className="mono">ffprobe {t.avgFpsFfprobe}</span>}>
        <b>{fps(t.avgFps)}</b>
      </Cell>
      <Cell k="Nominal FPS" p={p.nominalFps ?? p.dominantFps} extra={t.rFpsFfprobe && <span className="mono">r {t.rFpsFfprobe}</span>}>
        {nominal ? (
          <>
            <b>{fps(nominal)}</b> <small>{nominal.kind}</small>
          </>
        ) : dominant ? (
          <>
            <small>dominant</small> <b>{fps(dominant.rate)}</b> <small>{share(dominant.share)}</small>
          </>
        ) : (
          '-'
        )}
      </Cell>
      <Cell k="Min - max FPS" p={p.minFps}>
        {t.minFps && t.maxFps ? `${fps(t.minFps)} - ${fps(t.maxFps)}` : '-'}
      </Cell>
      <VfrCell t={t} />
      {t.duplicateTimestamps > 0 && (
        <Cell k="Duplicate timestamps" p={p.duplicateTimestamps}>
          {count(t.duplicateTimestamps)}
        </Cell>
      )}
    </>
  );
}

function Notes({ kind, label, items }: { kind: 'warn' | 'err'; label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <details className={`notes ${kind}`}>
      <summary>{label}</summary>
      <ul>
        {items.map((m, i) => (
          <li key={i}>{m}</li>
        ))}
      </ul>
    </details>
  );
}

function Progress({ row }: { row: Row }) {
  const { progress } = row;
  return (
    <div className="bar" role="status">
      <progress value={progress && progress.total > 0 ? progress.done : undefined} max={progress && progress.total > 0 ? progress.total : undefined} />
      <span>{progress ? `${progress.phase}${progress.total > 0 ? ` ${share(progress.done / progress.total)}` : ''}` : row.result ? 'Scanning' : 'Analyzing'}</span>
      <button type="button" onClick={() => cancelRow(row.id)}>
        Cancel
      </button>
    </div>
  );
}

function ErrorLine({ text }: { text: string }) {
  return text.length <= 100 ? <p className="err">{text}</p> : <Notes kind="err" label={`${text.slice(0, 100)}...`} items={[text]} />;
}

export const ResultCard = memo(function ResultCard({ row }: { row: Row }) {
  const [open, setOpen] = useState(false);
  const { file, result: r, busy } = row;
  const t = r ? primaryTrack(r) : null;
  const others = r && t ? r.videoTracks.filter((x) => x !== t) : [];
  const warnings = r ? [...new Set([...r.warnings, ...r.videoTracks.flatMap((x) => x.warnings)])] : [];
  const mkv = r?.container === 'webm' || r?.container === 'matroska';
  return (
    <article className="card" aria-busy={busy}>
      <header>
        <h3>{file.name}</h3>
        <span className="mut">{bytes(file.size)}</span>
        {r && r.container !== 'unknown' && (
          <span className="tag">
            {r.container}
            {r.brand ? ` ${r.brand.trim()}` : ''}
          </span>
        )}
        {r && r.audioTrackCount > 0 && <span className="tag">{r.audioTrackCount} audio</span>}
      </header>
      {r?.error && <ErrorLine text={`Error: ${r.error}`} />}
      {row.error && <ErrorLine text={row.error} />}
      {r && !r.error && !t && <p className="mut">No video track found.</p>}
      {r && t && (
        <dl className="grid">
          <TrackCells t={t} r={r} />
          <Cell k="Bytes read" title="unique bytes fetched from the file">
            {bytes(r.io.bytesRead)} <small>{readPercent(r.io.bytesRead, r.size)}, {count(r.io.reads)} read{r.io.reads === 1 ? '' : 's'}</small>
          </Cell>
          <Cell k="Time">{ms(r.io.ms)}</Cell>
          {mkv && (
            <Cell k="Scan depth" title={SCAN_HELP}>
              {r.scan ?? '-'}
            </Cell>
          )}
        </dl>
      )}
      {busy && <Progress row={row} />}
      {r && mkv && r.scan !== 'exact' && !busy && (
        <button type="button" className="act" onClick={() => rescan(row.id, 'exact')}>
          Scan all frames
        </button>
      )}
      {others.length > 0 && (
        <details className="notes">
          <summary>{others.length} more video track{others.length > 1 ? 's' : ''}</summary>
          {others.map((x) => (
            <section key={x.trackId}>
              <h4>Track {x.trackId}</h4>
              <dl className="grid">
                <TrackCells t={x} r={r!} />
              </dl>
            </section>
          ))}
        </details>
      )}
      <Notes kind="warn" label={`${warnings.length} warning${warnings.length > 1 ? 's' : ''}`} items={warnings} />
      {r && (
        <details className="cmp" onToggle={(e) => setOpen(e.currentTarget.open)}>
          <summary>Compare engines</summary>
          {open && (
            <Suspense fallback={<p className="mut">Loading...</p>}>
              <Compare row={row} />
            </Suspense>
          )}
        </details>
      )}
    </article>
  );
});
