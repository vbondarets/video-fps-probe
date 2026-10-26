import { ProbeError } from '../api/errors.ts';
import { containerFamily } from '../core/sniff.ts';
import type { AnalyzeOptions, AnalyzeProgress, EngineId, FileResult } from '../core/types.ts';
import type { ContainerFamily, EngineModule } from '../plugins/types.ts';
import type { SkipReason, WireOptions } from '../worker/protocol.ts';

export interface InlineRun {
  engine: EngineId;
  signals: readonly (AbortSignal | null | undefined)[];
  timeoutMs?: number;
  onProgress?: (progress: AnalyzeProgress) => void;
  host?: HTMLElement;
}

export type InlineReply = { type: 'result'; result: FileResult } | { type: 'skipped'; reason: SkipReason; family: ContainerFamily | null };

export function runInline(load: () => Promise<EngineModule>, file: Blob, name: string, options: WireOptions, run: InlineRun): Promise<InlineReply> {
  const { engine, signals, onProgress, host } = run;
  const timeoutMs = run.timeoutMs ?? 0;
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
    const fail = (error: ProbeError) => {
      controller.abort();
      finish(() => reject(error));
    };
    const onAbort = () => fail(new ProbeError('aborted', 'aborted', { engine, cause: signals.find((s) => s?.aborted)?.reason }));
    if (signals.some((s) => s?.aborted)) return onAbort();
    for (const s of signals) s?.addEventListener('abort', onAbort);
    if (timeoutMs > 0 && timeoutMs <= 2 ** 31 - 1) timer = setTimeout(() => fail(new ProbeError('timeout', `timed out after ${timeoutMs} ms`, { engine })), timeoutMs);
    let loading = true;
    (async (): Promise<InlineReply> => {
      const module = await load();
      loading = false;
      if (module.containers !== 'any') {
        const family = await containerFamily(file);
        if (!family || !module.containers.includes(family)) return { type: 'skipped', reason: 'unsupported-container', family };
      }
      const opts: AnalyzeOptions & { host?: HTMLElement } = { ...options, signal: controller.signal, onProgress, host };
      return { type: 'result', result: await module.run(file, name, opts) };
    })().then(
      (reply) => finish(() => resolve(reply)),
      (e: unknown) => ((e as ProbeError | null)?.name === 'ProbeError' && typeof (e as ProbeError).code === 'string' ? finish(() => reject(e)) : fail(Object.assign(new ProbeError('worker-failed', e instanceof Error ? e.message || e.name : String(e), { engine, cause: e }), { reason: loading ? ('load' as const) : ('crash' as const) }))),
    );
  });
}
