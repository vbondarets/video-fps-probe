import { memo, useRef, useState } from 'react';
import type { FileResult, RateProfile, VideoTrackResult } from 'video-fps-probe';
import { bytes, count, ms, primaryTrack, readPercent, share } from './format.ts';
import { retryable } from './retryable.tsx';
import { Cell, ErrorLine, Notes, TrackCells } from './cells.tsx';
import { cancelRow, rescan, type Row } from './store.ts';

const Compare = retryable<{ row: Row }>(() => import('./Compare.tsx'), <p className="mut">Loading...</p>);
const RateProfileView = retryable<{ p: RateProfile }>(() => import('./RateProfile.tsx'));
const Details = retryable<{ r: FileResult; t: VideoTrackResult | null }>(() => import('./Details.tsx'));

const SCAN_HELP = 'header: container headers only. probe: headers plus sampled blocks. exact: every block walked.';

function Progress({ row }: { row: Row }) {
  const { progress } = row;
  return (
    <div className="bar">
      <progress value={progress && progress.total > 0 ? progress.done : undefined} max={progress && progress.total > 0 ? progress.total : undefined} />
      <span>{progress ? `${progress.phase}${progress.total > 0 ? ` ${share(progress.done / progress.total)}` : ''}` : row.result ? 'Scanning' : 'Analyzing'}</span>
      <button type="button" onClick={() => cancelRow(row.id)}>
        Cancel
      </button>
    </div>
  );
}

export const ResultCard = memo(function ResultCard({ row }: { row: Row }) {
  const [open, setOpen] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const { file, result: r, busy } = row;
  const t = r ? primaryTrack(r) : null;
  const others = r && t ? r.videoTracks.filter((x) => x !== t) : [];
  const warnings = r ? [...new Set([...r.warnings, ...r.videoTracks.flatMap((x) => x.warnings)])] : [];
  const mkv = r?.container === 'webm' || r?.container === 'matroska';
  return (
    <article className="card" aria-busy={busy}>
      <header>
        <h3 ref={heading} tabIndex={-1}>
          {file.name}
        </h3>
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
      {!r && !busy && !row.error && <p className="mut">Not analyzed.</p>}
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
      {r && <Details r={r} t={t} />}
      {t?.rateProfile && <RateProfileView p={t.rateProfile} />}
      {busy && <Progress row={row} />}
      {r && t && mkv && r.scan !== 'exact' && !busy && (
        <p className="act">
          <button
            type="button"
            onClick={() => {
              rescan(row.id, 'exact');
              heading.current?.focus();
            }}
          >
            Scan all frames
          </button>{' '}
          <small>to check for rate changes and stalls</small>
        </p>
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
              {x.rateProfile && <RateProfileView p={x.rateProfile} />}
            </section>
          ))}
        </details>
      )}
      <Notes kind="warn" label={`${warnings.length} warning${warnings.length > 1 ? 's' : ''}`} items={warnings} />
      {r && (
        <details className="cmp" onToggle={(e) => setOpen(e.currentTarget.open)}>
          <summary>Compare engines</summary>
          {open && <Compare row={row} />}
        </details>
      )}
    </article>
  );
});
