import { compareResults } from '../api/agreement.ts';
import { isAbortError, ProbeError } from '../api/errors.ts';
import type { EngineId } from '../core/types.ts';
import { failureOf } from './fallback.ts';
import { nameOf, type CompareContext } from './probe.ts';
import type { CompareOptions, CompareResult, EngineOutcome, ProbeResult } from './types.ts';

export async function compare<K extends EngineId>(ctx: CompareContext, file: Blob, o: CompareOptions<K> = {}): Promise<CompareResult<K>> {
  const name = nameOf(file);
  const ids = [...new Set(o.engines ?? (ctx.engines.filter((id) => id !== 'rvfc') as K[]))];
  const missing = ids.find((id) => !ctx.has(id));
  if (missing) throw new ProbeError('engine-not-registered', `engine ${missing} is not registered`, { engine: missing });
  const wire = { ...ctx.defaults };
  const { signal, timeoutMs, onProgress } = o;

  const outcomeOf = async (id: K): Promise<EngineOutcome> => {
    const t0 = performance.now();
    try {
      const reply = await ctx.run(id, file, name, wire, { signal, timeoutMs, onProgress: onProgress && ((p) => onProgress({ ...p, engine: id })) });
      if (reply.type === 'skipped') return { status: 'skipped', reason: reply.reason };
      const ms = performance.now() - t0;
      const result: ProbeResult = reply.result;
      const error = failureOf(result);
      return error === null ? { status: 'ok', result, ms } : { status: 'failed', result, error, ms };
    } catch (e) {
      if (isAbortError(e)) throw e;
      const error = e instanceof ProbeError ? e : new ProbeError('worker-failed', String(e), { engine: id, cause: e });
      if (error.code === 'unsupported-environment') return { status: 'skipped', reason: 'unsupported-environment' };
      return { status: error.code === 'timeout' ? 'timeout' : 'crashed', error };
    }
  };

  const groups = new Map<string, K[]>();
  for (const id of ids) {
    const kind = ctx.kindOf(id);
    groups.set(kind, [...(groups.get(kind) ?? []), id]);
  }
  const outcomes: Partial<Record<K, EngineOutcome>> = {};
  await Promise.all(
    [...groups.values()].map(async (group) => {
      for (const id of group) outcomes[id] = await outcomeOf(id);
    }),
  );
  const results: Partial<Record<K, ProbeResult>> = {};
  for (const id of ids) {
    const outcome = outcomes[id];
    if (outcome && 'result' in outcome) results[id] = outcome.result;
  }
  const agreement = compareResults(results, o.reference);
  return { name, size: file.size, reference: agreement.reference, outcomes, agreement };
}
