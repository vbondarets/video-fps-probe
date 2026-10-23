import { isAbortError, ProbeError } from '../api/errors.ts';
import { emptyAnalysis, primaryTrack } from '../core/result.ts';
import type { EngineId } from '../core/types.ts';
import type { WireOptions } from '../worker/protocol.ts';
import type { InlineReply } from './inline.ts';
import type { Run } from './probe.ts';
import type { Attempt, CallOptions, ProbeResult } from './types.ts';

type Failure = Attempt & { result?: ProbeResult };

export const failureOf = (r: ProbeResult): string | null => {
  const t = primaryTrack(r);
  return r.error ?? (!t ? 'no video track' : t.avgFps ? null : 'no frame rate');
};

const withAttempts = (result: ProbeResult, failures: readonly Failure[]): ProbeResult =>
  failures.length > 0 ? { ...result, attempts: failures.map(({ engine, error }) => ({ engine, error })) } : result;

export async function runChain(
  run: Run,
  chain: readonly EngineId[],
  file: Blob,
  name: string,
  wire: WireOptions,
  call: CallOptions<EngineId>,
  first: InlineReply | null,
): Promise<ProbeResult> {
  const failures: Failure[] = [];
  let last: ProbeError | null = null;
  for (const [i, id] of chain.entries()) {
    let result: ProbeResult;
    try {
      const reply = i === 0 && first ? first : await run(id, file, name, wire, call);
      result =
        reply.type === 'result'
          ? reply.result
          : { name, size: file.size, ...emptyAnalysis('unknown', `${id} does not read this container`), io: { reads: 0, bytesRead: 0, ms: 0 }, engine: id };
    } catch (e) {
      if (isAbortError(e)) throw e;
      last = e instanceof ProbeError ? e : new ProbeError('worker-failed', String(e), { engine: id, cause: e });
      failures.push({ engine: id, error: last.message });
      continue;
    }
    const error = failureOf(result);
    if (error === null || chain.length === 1) return withAttempts(result, failures);
    failures.push({ engine: id, error, result });
  }
  for (let i = failures.length - 1; i >= 0; i--) {
    const { result } = failures[i];
    if (result) return withAttempts(result, failures.slice(0, i).concat(failures.slice(i + 1)));
  }
  throw last;
}
