import { useId } from 'react';
import type { RateProfile } from 'video-fps-probe';
import { clock, count, rate, share } from './format.ts';

const W = 240;
const H = 40;

export default function RateProfileView({ p }: { p: RateProfile }) {
  const id = useId();
  const values = p.buckets.fps;
  const top = Math.log1p(Math.max(...values)) || 1;
  const step = W / values.length;
  const y = (v: number): number => H - 1 - (Math.log1p(v) / top) * (H - 3);
  const path = `M0 ${H}${values.map((v, i) => `V${y(v).toFixed(1)}H${((i + 1) * step).toFixed(1)}`).join('')}V${H}Z`;
  const total = p.moreSegments ? values.length * p.buckets.bucketSec : p.segments[p.segments.length - 1].endSec;
  const n = p.segments.length + p.moreSegments;
  const m = p.anomalies.length + p.moreAnomalies;
  return (
    <section className="rp">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-labelledby={`${id}t`} aria-describedby={`${id}d`}>
        <title id={`${id}t`}>Frame rate over time, log scale</title>
        <desc id={`${id}d`}>{`${rate(Math.min(...values))} to ${rate(Math.max(...values))} fps over ${clock(total)}`}</desc>
        <path d={path} />
      </svg>
      <p>{p.summary}</p>
      <details>
        <summary>
          {n} segment{n > 1 ? 's' : ''}, {m} anomal{m === 1 ? 'y' : 'ies'}, {p.dominantShare > 0 ? `dominant rate ${share(p.dominantShare)} of the time` : 'no steady rate'}
        </summary>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>FPS</th>
                <th>Frames</th>
                <th>Share</th>
              </tr>
            </thead>
            <tbody>
              {p.segments.map((s, i) => (
                <tr key={i}>
                  <td>
                    {clock(s.startSec)}-{clock(s.endSec)}
                  </td>
                  <td>
                    {s.kind === 'variable' ? `~${rate(s.fps)} variable` : rate(s.fps)}
                  </td>
                  <td>{count(s.frames)}</td>
                  <td>{share((s.endSec - s.startSec) / total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {p.moreSegments > 0 && <p className="mut">{p.moreSegments} more segments not listed</p>}
        {m > 0 && (
          <ul>
            {p.anomalies.map((a, i) => (
              <li key={i}>
                {a.kind.replace('-', ' ')} at {clock(a.atSec)}
                {a.durationSec > 0 && ` for ${rate(a.durationSec)} s`}: {rate(a.fromFps)} to {rate(a.toFps)} fps
              </li>
            ))}
            {p.moreAnomalies > 0 && <li className="mut">{p.moreAnomalies} more</li>}
          </ul>
        )}
      </details>
    </section>
  );
}
