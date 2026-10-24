import { emptyAnalysis, emptyTrack } from '../../src/core/result.ts';
import type { EngineId, FileResult } from '../../src/core/types.ts';
import type { WorkerRequest, WorkerResponse } from '../../src/worker/protocol.ts';

export function fakeResult(name: string, engine: EngineId = 'own', fps: number | null = 30): FileResult {
  const track = { ...emptyTrack(1), avgFps: fps === null ? null : { num: fps, den: 1, value: fps } };
  return { name, size: 8, ...emptyAnalysis('mp4'), videoTracks: [track], primaryTrackId: 1, io: { reads: 0, bytesRead: 0, ms: 0 }, engine };
}

export type Responder = (request: WorkerRequest, worker: FakeWorker) => Partial<WorkerResponse> | 'hang' | undefined;

export type Behaviour = 'reply' | 'hang' | 'manual';

export class FakeWorker {
  static instances: FakeWorker[] = [];
  static behaviour: Behaviour = 'reply';
  static respond: Responder | null = null;

  onmessage: ((event: { data: WorkerResponse }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  posted: WorkerRequest[] = [];
  terminated = false;
  readonly behaviour: Behaviour = FakeWorker.behaviour;
  readonly label: string;

  constructor(label = '') {
    this.label = label;
    FakeWorker.instances.push(this);
  }

  static reset(behaviour: Behaviour = 'reply', respond: Responder | null = null): void {
    FakeWorker.instances = [];
    FakeWorker.behaviour = behaviour;
    FakeWorker.respond = respond;
  }

  static create = (): Worker => new FakeWorker() as unknown as Worker;

  static as = (label: string) => (): Worker => new FakeWorker(label) as unknown as Worker;

  postMessage(message: WorkerRequest): void {
    this.posted.push(message);
    if (this.behaviour !== 'reply' || message.type === 'cancel') return;
    const reply = FakeWorker.respond?.(message, this);
    if (reply !== 'hang') queueMicrotask(() => this.answer(message.id, reply));
  }

  terminate(): void {
    this.terminated = true;
  }

  get pending(): WorkerRequest[] {
    return this.posted.filter((m) => m.type !== 'cancel');
  }

  answer(id: number, reply?: Partial<WorkerResponse>): void {
    if (this.terminated) return;
    const request = this.posted.find((m) => m.id === id);
    const base =
      request?.type === 'warm'
        ? { type: 'warmed' as const }
        : { type: 'result' as const, result: request?.type === 'analyze' ? fakeResult(request.name, request.engine) : fakeResult('') };
    this.onmessage?.({ data: { v: 1, id, ...base, ...reply } as WorkerResponse });
  }

  crash(message = 'boom'): void {
    this.onerror?.({ message });
  }

  failToLoad(): void {
    this.onerror?.(new Event('error') as unknown as { message: string });
  }
}

export const analyzeRequest = (name: string) => ({ type: 'analyze' as const, file: new Blob([new Uint8Array(8)]), name, engine: 'own' as const, options: {} });
