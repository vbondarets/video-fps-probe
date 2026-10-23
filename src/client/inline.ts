import { ProbeError, type ProbeErrorCode } from '../api/errors.ts';
import { containerFamily } from '../core/sniff.ts';
import type { AnalyzeOptions, AnalyzeProgress, EngineId, FileResult } from '../core/types.ts';
import type { EngineModule } from '../plugins/types.ts';
import type { SkipReason, WireOptions } from '../worker/protocol.ts';
import { delayOf } from './pool.ts';

export interface InlineRun {
  engine: EngineId;
  signals: readonly (AbortSignal | null | undefined)[];
  timeoutMs?: number;
  onProgress?: (progress: AnalyzeProgress) => void;
  host?: HTMLElement;
}

export type InlineReply = { type: 'result'; result: FileResult } | { type: 'skipped'; reason: SkipReason };

export function runInline(load: () => Promise<EngineModule>, file: Blob, name: string, options: WireOptions, run: InlineRun): Promise<InlineReply> {
  const { engine, signals, onProgress, host } = run;
  const timeoutMs = delayOf(run.timeoutMs);
  const controller = new AbortController();
  return new Promise<InlineReply>((resolve, reject) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (settle: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const s of signals) s?.removeEventListener('abort', onAbort);
      settle();
    };
    const fail = (code: ProbeErrorCode, message: string, cause?: unknown) => {
      controller.abort();
      finish(() => reject(new ProbeError(code, message, { engine, cause })));
    };
    const onAbort = () => fail('aborted', 'aborted', signals.find((s) => s?.aborted)?.reason);
    if (signals.some((s) => s?.aborted)) return onAbort();
    for (const s of signals) s?.addEventListener('abort', onAbort);
    if (timeoutMs > 0) timer = setTimeout(() => fail('timeout', `timed out after ${timeoutMs} ms`), timeoutMs);
    (async (): Promise<InlineReply> => {
      const module = await load();
      if (module.containers !== 'any') {
        const family = await containerFamily(file);
        if (!family || !module.containers.includes(family)) return { type: 'skipped', reason: 'unsupported-container' };
      }
      const opts: AnalyzeOptions & { host?: HTMLElement } = { ...options, signal: controller.signal, onProgress, host };
      return { type: 'result', result: await module.run(file, name, opts) };
    })().then(
      (reply) => finish(() => resolve(reply)),
      (e: unknown) => (e instanceof ProbeError ? finish(() => reject(e)) : fail('worker-failed', e instanceof Error ? e.message || e.name : String(e), e)),
    );
  });
}
