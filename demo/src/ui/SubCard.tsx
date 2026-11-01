import type { ReactNode } from 'react';
import type { FileResult } from 'video-fps-probe';
import Details from './Details.tsx';
import { bytes, count, ms, primaryTrack } from './format.ts';
import { ErrorLine, Notes, TrackCells } from './cells.tsx';

export type PlannedResult = FileResult & { io: FileResult['io'] & { bytesRequested?: number } };

export default function SubCard({ r, extra }: { r: PlannedResult; extra?: ReactNode }) {
  const t = primaryTrack(r);
  const warnings = [...new Set([...r.warnings, ...r.videoTracks.flatMap((x) => x.warnings)])];
  const requested = r.io.bytesRequested;
  return (
    <article className="sub" data-name={r.name}>
      <header>
        <h3>{r.name}</h3>
        <span className="mut">{bytes(r.size)}</span>
        {r.container !== 'unknown' && <span className="tag">{r.container}</span>}
      </header>
      <p className="plan">
        <b>Read plan:</b> {count(r.io.reads)} read{r.io.reads === 1 ? '' : 's'}
        {requested !== undefined && `, ${bytes(requested)} requested`}, {bytes(r.io.bytesRead)} read, {ms(r.io.ms)}
        {extra}
      </p>
      {r.error && <ErrorLine text={`Error: ${r.error}`} />}
      {t && (
        <dl className="grid">
          <TrackCells t={t} r={r} />
        </dl>
      )}
      <Details r={r} t={t} />
      <Notes kind="warn" label={`${warnings.length} warning${warnings.length > 1 ? 's' : ''}`} items={warnings} />
    </article>
  );
}
