import { ProbeError, type ProbeErrorCode } from '../api/errors.ts';
import type { AnalyzeProgress, EngineId } from '../core/types.ts';
import { PROTOCOL_VERSION, type JobRequest, type WorkerRequest, type WorkerResponse } from '../worker/protocol.ts';

export const KILL_AFTER_MS = 1500;
export const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
export const LOAD_FAILED = 'worker script failed to load or parse; the app may have been redeployed';
const MAX_DELAY_MS = 2 ** 31 - 1;

const delayOf = (ms = 0): number => (ms > 0 && ms <= MAX_DELAY_MS ? ms : 0);

export const workerFailed = (message: string, reason: NonNullable<ProbeError['reason']>, engine?: EngineId | null, cause?: unknown): ProbeError =>
  Object.assign(new ProbeError('worker-failed', message, { engine, cause }), { reason });

export interface PoolOptions {
  create: () => Worker;
  size?: number;
  idleTimeoutMs?: number;
}

export interface RunOptions {
  signal?: AbortSignal | null;
  timeoutMs?: number;
  onProgress?: (progress: AnalyzeProgress) => void;
  engine?: EngineId | null;
}

export type PoolReply = Extract<WorkerResponse, { type: 'result' | 'skipped' | 'warmed' }>;

interface Job {
  id: number;
  request: JobRequest;
  options: RunOptions;
  done?: boolean;
  timer?: ReturnType<typeof setTimeout>;
  resolve(reply: PoolReply): void;
  reject(reason: ProbeError): void;
  detach(): void;
}

interface Slot {
  worker: Worker;
  job: Job | null;
  answered?: boolean;
  idle?: ReturnType<typeof setTimeout>;
}

export class WorkerPool {
  readonly #create: () => Worker;
  readonly #size: number;
  readonly #idleMs: number;
  readonly #slots: Slot[] = [];
  readonly #queue: Job[] = [];
  #nextId = 1;
  #cap: number;

  constructor(options: PoolOptions) {
    this.#create = options.create;
    const size = options.size ?? 1;
    this.#cap = this.#size = Number.isFinite(size) && size >= 1 ? Math.floor(size) : 1;
    this.#idleMs = delayOf(options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);
  }

  get workers(): number {
    return this.#slots.length;
  }

  run(request: JobRequest, options: RunOptions = {}): Promise<PoolReply> {
    const { signal } = options;
    return new Promise<PoolReply>((resolve, reject) => {
      const onAbort = () => this.#abort(job);
      const job: Job = { id: this.#nextId++, request, options, resolve, reject, detach: () => signal?.removeEventListener('abort', onAbort) };
      if (signal?.aborted) return this.#fail(job, 'aborted', 'aborted', signal.reason);
      signal?.addEventListener('abort', onAbort);
      this.#cap = this.#size;
      this.#queue.push(job);
      this.#pump();
    });
  }

  dispose(): void {
    for (const slot of [...this.#slots]) if (!slot.job) this.#discard(slot);
  }

  destroy(): void {
    for (const job of [...this.#queue.splice(0), ...this.#slots.map((s) => s.job)]) if (job) this.#fail(job, 'aborted', 'pool destroyed');
    for (const slot of [...this.#slots]) this.#discard(slot);
  }

  #settle(job: Job, outcome: PoolReply | ProbeError): void {
    if (job.done) return;
    job.done = true;
    clearTimeout(job.timer);
    job.detach();
    if (outcome instanceof ProbeError) job.reject(outcome);
    else job.resolve(outcome);
  }

  #fail(job: Job, code: ProbeErrorCode, message: string, cause?: unknown): void {
    this.#settle(job, new ProbeError(code, message, { engine: job.options.engine, cause }));
  }

  #broken(job: Job, message: string, reason: NonNullable<ProbeError['reason']>, cause?: unknown): void {
    this.#settle(job, workerFailed(message, reason, job.options.engine, cause));
  }

  #abort(job: Job): void {
    this.#fail(job, 'aborted', 'aborted', job.options.signal?.reason);
    const queued = this.#queue.indexOf(job);
    if (queued >= 0) {
      this.#queue.splice(queued, 1);
      return;
    }
    const slot = this.#slots.find((s) => s.job === job);
    if (!slot) return;
    slot.worker.postMessage({ v: PROTOCOL_VERSION, type: 'cancel', id: job.id } satisfies WorkerRequest);
    setTimeout(() => {
      if (slot.job === job) this.#kill(slot);
    }, KILL_AFTER_MS);
  }

  #discard(slot: Slot): void {
    clearTimeout(slot.idle);
    slot.worker.terminate();
    const i = this.#slots.indexOf(slot);
    if (i >= 0) this.#slots.splice(i, 1);
  }

  #kill(slot: Slot): void {
    this.#discard(slot);
    this.#pump();
  }

  #release(slot: Slot): void {
    slot.job = null;
    this.#pump();
    if (!slot.job && this.#idleMs > 0 && this.#slots.includes(slot)) {
      slot.idle = setTimeout(() => this.#discard(slot), this.#idleMs);
    }
  }

  #spawn(): Slot {
    const worker = this.#create();
    const slot: Slot = { worker, job: null };
    worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
      slot.answered = true;
      const job = slot.job;
      if (job?.id !== data.id) return;
      if (data.type === 'progress') {
        if (!job.done) job.options.onProgress?.(data.progress);
        return;
      }
      if (data.type !== 'error') this.#settle(job, data);
      else if (data.aborted || data.code) this.#fail(job, data.aborted ? 'aborted' : data.code!, data.message);
      else this.#broken(job, data.message, data.reason ?? 'crash');
      this.#release(slot);
    };
    worker.onerror = (event) => {
      const load = !slot.answered;
      const job = slot.job;
      this.#discard(slot);
      if (load && this.#slots.length > 0) {
        this.#cap = this.#slots.length;
        if (job && !job.done) {
          clearTimeout(job.timer);
          this.#queue.unshift(job);
        }
      } else {
        const message = load ? [LOAD_FAILED, event.message].filter(Boolean).join(': ') : event.message || 'worker failed';
        for (const failed of load ? [job, ...this.#queue.splice(0)] : [job]) {
          if (failed) this.#broken(failed, message, load ? 'load' : 'crash', event);
        }
      }
      this.#pump();
    };
    this.#slots.push(slot);
    return slot;
  }

  #pump(): void {
    while (this.#queue.length > 0) {
      let slot = this.#slots.find((s) => !s.job);
      if (!slot && this.#slots.length < this.#cap) {
        try {
          slot = this.#spawn();
        } catch (e) {
          this.#broken(this.#queue.shift()!, String(e), 'load', e);
          continue;
        }
      }
      if (!slot) return;
      const job = this.#queue.shift()!;
      clearTimeout(slot.idle);
      slot.job = job;
      const timeoutMs = delayOf(job.options.timeoutMs);
      if (timeoutMs > 0) {
        job.timer = setTimeout(() => {
          this.#fail(job, 'timeout', `timed out after ${timeoutMs} ms`);
          if (slot.job === job) this.#kill(slot);
        }, timeoutMs);
      }
      slot.worker.postMessage({ v: PROTOCOL_VERSION, id: job.id, ...job.request } satisfies WorkerRequest);
    }
  }
}
