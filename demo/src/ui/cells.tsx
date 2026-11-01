import type { ReactNode } from 'react';
import type { FileResult, Provenance, VideoTrackResult } from 'video-fps-probe';
import { count, duration, fps, PROVENANCE, share } from './format.ts';

export function Mark({ p }: { p: Provenance }) {
  const [glyph, text] = PROVENANCE[p];
  return (
    <abbr className={`p p-${p}`} title={text}>
      <span aria-hidden="true">{glyph}</span>
      <span className="sr">{` (${p})`}</span>
    </abbr>
  );
}

interface CellProps {
  k: string;
  p?: Provenance | undefined;
  title?: string;
  extra?: ReactNode;
  children: ReactNode;
}

export function Cell({ k, p, title, extra, children }: CellProps) {
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

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

function stallBadge(t: VideoTrackResult): string | null {
  const prof = t.rateProfile;
  if (!prof || prof.uneven) return null;
  const freezes = prof.anomalies.filter((a) => a.kind === 'freeze').length;
  const gaps = prof.anomalies.filter((a) => a.kind === 'gap').length;
  if (freezes) return plural(freezes, 'freeze');
  return gaps ? plural(gaps, 'gap') : null;
}

function VfrCell({ t }: { t: VideoTrackResult }) {
  const sampled = t.provenance.isVfr === 'sampled';
  const uneven = t.rateProfile?.uneven ?? false;
  const stalls = stallBadge(t);
  let body: ReactNode = <span className="mut">n/a</span>;
  if (t.isStill) body = <span className="mut">still image</span>;
  else if (t.isVfr && uneven) body = <span className="badge vfr">VFR</span>;
  else if (t.isVfr) body = <span className="badge vfr" title="share of frame intervals that differ from the median">VFR {share(t.vfrRatio)}</span>;
  else if (t.isVfr === false && sampled) {
    body = (
      <span className="badge" title="probe mode reads a few clusters only: scan all frames for a verdict">
        no VFR in sample
      </span>
    );
  } else if (t.isVfr === false) {
    body = <span className="badge cfr">{t.timestampsQuantized ? 'CFR, 1 ms quantized' : 'CFR'}</span>;
  }
  return (
    <Cell k="Frame timing" p={t.provenance.isVfr}>
      {body}
      {uneven && (
        <span className="badge uneven" title="the frame rate changes over time or frames stall: see the rate profile">
          uneven
        </span>
      )}
      {stalls && (
        <span className="badge uneven" title="frames stall in an otherwise steady stream: see the rate profile">
          {stalls}
        </span>
      )}
    </Cell>
  );
}

export function TrackCells({ t, r }: { t: VideoTrackResult; r: FileResult }) {
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
        ) : dominant && t.rateProfile?.uneven ? (
          <small>varies, see the rate profile</small>
        ) : dominant ? (
          <>
            <small>dominant</small> <b>{fps(dominant.rate)}</b> <small>{share(dominant.share)} of frames</small>
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

export function Notes({ kind, label, items }: { kind: 'warn' | 'err'; label: string; items: string[] }) {
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

export function ErrorLine({ text }: { text: string }) {
  return text.length <= 200 ? <p className="err">{text}</p> : <Notes kind="err" label={`${text.slice(0, 200)}...`} items={[text]} />;
}

