import type { AnalyzeProgress, FileResult } from '../core/types.ts';
import type { WireOptions, WorkerEngine, WorkerRequest, WorkerResponse } from '../worker/protocol.ts';

const POOL_SIZE = 2;
const KILL_AFTER_MS = 1500;

interface Job {
  id: number;
  file: File;
  engine: WorkerEngine;
  options: WireOptions;
  onProgress: ((progress: AnalyzeProgress) => void) | undefined;
  resolve(result: FileResult): void;
  reject(reason: unknown): void;
}

interface Slot {
  worker: Worker;
  job: Job | null;
}

export interface Submitted {
  promise: Promise<FileResult>;
  cancel(): void;
}

const slots: Slot[] = [];
const queue: Job[] = [];
let nextId = 1;

const abortError = () => new DOMException('Aborted', 'AbortError');

function release(slot: Slot): void {
  slot.job = null;
  pump();
}

function discard(slot: Slot): void {
  slot.worker.terminate();
  const i = slots.indexOf(slot);
  if (i >= 0) slots.splice(i, 1);
}

function spawn(): Slot {
  const worker = new Worker(new URL('../worker/analyze.worker.ts', import.meta.url), { type: 'module' });
  const slot: Slot = { worker, job: null };
  worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
    const job = slot.job;
    if (!job || job.id !== data.id) return;
    if (data.type === 'progress') {
      job.onProgress?.(data.progress);
      return;
    }
    if (data.type === 'result') job.resolve(data.result);
    else job.reject(data.aborted ? abortError() : new Error(data.message));
    release(slot);
  };
  worker.onerror = (event) => {
    const job = slot.job;
    discard(slot);
    job?.reject(new Error(event.message || 'worker failed'));
    pump();
  };
  slots.push(slot);
  return slot;
}

function pump(): void {
  while (queue.length > 0) {
    const slot = slots.find((s) => s.job === null) ?? (slots.length < POOL_SIZE ? spawn() : null);
    if (!slot) return;
    const job = queue.shift()!;
    slot.job = job;
    const request: WorkerRequest = { type: 'analyze', id: job.id, file: job.file, engine: job.engine, options: job.options };
    slot.worker.postMessage(request);
  }
}

export function submit(
  file: File,
  engine: WorkerEngine,
  options: WireOptions,
  onProgress?: (progress: AnalyzeProgress) => void,
): Submitted {
  let job!: Job;
  const promise = new Promise<FileResult>((resolve, reject) => {
    job = { id: nextId++, file, engine, options, onProgress, resolve, reject };
  });
  queue.push(job);
  pump();
  return {
    promise,
    cancel() {
      const queued = queue.indexOf(job);
      if (queued >= 0) {
        queue.splice(queued, 1);
        job.reject(abortError());
        return;
      }
      const slot = slots.find((s) => s.job === job);
      if (!slot) return;
      const request: WorkerRequest = { type: 'cancel', id: job.id };
      slot.worker.postMessage(request);
      job.reject(abortError());
      setTimeout(() => {
        if (slot.job !== job) return;
        discard(slot);
        pump();
      }, KILL_AFTER_MS);
    },
  };
}
