import { analyze, isAbortError } from '../core/index.ts';
import type { AnalyzeOptions, FileResult } from '../core/types.ts';
import type { WorkerEngine, WorkerRequest, WorkerResponse } from './protocol.ts';

const PROGRESS_INTERVAL_MS = 50;

const ctx = self as unknown as {
  postMessage(message: WorkerResponse): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
};

const running = new Map<number, AbortController>();

async function runEngine(file: File, engine: WorkerEngine, opts: AnalyzeOptions): Promise<FileResult> {
  if (engine === 'mp4box') {
    return (await import('../engines/mp4box.ts')).analyzeWithMp4box(file, file.name, opts);
  }
  if (engine === 'mediabunny') {
    return (await import('../engines/mediabunny.ts')).analyzeWithMediabunny(file, file.name, opts);
  }
  return analyze(file, file.name, opts);
}

async function handle(job: Extract<WorkerRequest, { type: 'analyze' }>): Promise<void> {
  const controller = new AbortController();
  running.set(job.id, controller);
  let lastProgress = 0;
  try {
    const result = await runEngine(job.file, job.engine, {
      ...job.options,
      signal: controller.signal,
      onProgress: (progress) => {
        const now = performance.now();
        if (now - lastProgress < PROGRESS_INTERVAL_MS) return;
        lastProgress = now;
        ctx.postMessage({ type: 'progress', id: job.id, progress });
      },
    });
    ctx.postMessage({ type: 'result', id: job.id, result });
  } catch (e) {
    const aborted = controller.signal.aborted || isAbortError(e);
    ctx.postMessage({ type: 'error', id: job.id, message: e instanceof Error ? e.message || e.name : String(e), aborted });
  } finally {
    running.delete(job.id);
  }
}

ctx.onmessage = ({ data }) => {
  if (data.type === 'cancel') running.get(data.id)?.abort();
  else void handle(data);
};
