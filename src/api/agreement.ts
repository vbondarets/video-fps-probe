import { primaryTrack } from '../core/result.ts';
import type { EngineId, FileResult, Provenance, Rational, VideoTrackResult } from '../core/types.ts';

export type ComparedFieldName = 'avgFps' | 'nominalFps' | 'minFps' | 'maxFps' | 'frames' | 'durationSec';

export type ComparedValue = Rational | number | null;

export interface ComparedField<K extends EngineId> {
  field: ComparedFieldName;
  values: Partial<Record<K, ComparedValue>>;
  agree: boolean | null;
  differ: K[];
}

export interface Agreement<K extends EngineId> {
  reference: K | null;
  engines: K[];
  fields: ComparedField<K>[];
  agree: boolean | null;
}

export const RELATIVE_TOLERANCE = 0.003;
export const DURATION_TOLERANCE_SEC = 1e-6;

const RATIONALS = ['avgFps', 'nominalFps', 'minFps', 'maxFps'] as const;
const APPROXIMATE: ReadonlySet<Provenance | undefined> = new Set<Provenance | undefined>(['estimated', 'sampled']);

const sameRational = (a: Rational, b: Rational): boolean =>
  [a.num, a.den, b.num, b.den].every(Number.isSafeInteger) ? BigInt(a.num) * BigInt(b.den) === BigInt(b.num) * BigInt(a.den) : a.num / a.den === b.num / b.den;

function valueOf(t: VideoTrackResult, field: ComparedFieldName): ComparedValue {
  if (field === 'frames') return t.presentedFrames ?? t.frames;
  if (field === 'durationSec') return t.durationSec;
  return t[field];
}

function equal(field: ComparedFieldName, a: VideoTrackResult, b: VideoTrackResult): boolean {
  const x = valueOf(a, field);
  const y = valueOf(b, field);
  if (typeof x === 'number' && typeof y === 'number') return field === 'durationSec' ? Math.abs(x - y) <= DURATION_TOLERANCE_SEC : x === y;
  const p = x as Rational;
  const q = y as Rational;
  if (sameRational(p, q)) return true;
  const approximate = APPROXIMATE.has(a.provenance[field as (typeof RATIONALS)[number]]) || APPROXIMATE.has(b.provenance[field as (typeof RATIONALS)[number]]);
  return approximate && Math.abs(p.value / q.value - 1) <= RELATIVE_TOLERANCE;
}

export function compareResults<K extends EngineId>(results: Partial<Record<K, FileResult>>, reference?: NoInfer<K>): Agreement<K> {
  const tracks = new Map<K, VideoTrackResult>();
  for (const [engine, result] of Object.entries(results) as [K, FileResult | undefined][]) {
    const t = result && !result.error ? primaryTrack(result) : null;
    if (t) tracks.set(engine, t);
  }
  const engines = [...tracks.keys()];
  const ref = reference !== undefined ? (tracks.has(reference) ? reference : null) : tracks.has('own' as K) ? ('own' as K) : (engines[0] ?? null);
  const fields = ([...RATIONALS, 'frames', 'durationSec'] as const).map((field): ComparedField<K> => {
    const values: Partial<Record<K, ComparedValue>> = {};
    for (const [engine, t] of tracks) values[engine] = valueOf(t, field);
    const base = ref === null ? null : tracks.get(ref)!;
    const differ: K[] = [];
    let compared = 0;
    if (base && valueOf(base, field) !== null) {
      for (const [engine, t] of tracks) {
        if (engine === ref || valueOf(t, field) === null) continue;
        compared++;
        if (!equal(field, base, t)) differ.push(engine);
      }
    }
    return { field, values, agree: compared === 0 ? null : differ.length === 0, differ };
  });
  const decided = fields.filter((f) => f.agree !== null);
  return { reference: ref, engines, fields, agree: decided.length === 0 ? null : decided.every((f) => f.agree) };
}
