import type { WorkerRequest, WorkerResponse } from '../../src/worker/protocol.ts';

export type Behaviour = 'reply' | 'hang' | 'manual';

export class FakeWorker {
  static instances: FakeWorker[] = [];
  static behaviour: Behaviour = 'reply';

  onmessage: ((event: { data: WorkerResponse }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  posted: WorkerRequest[] = [];
  terminated = false;
  readonly behaviour: Behaviour = FakeWorker.behaviour;

  constructor() {
    FakeWorker.instances.push(this);
  }

  static reset(behaviour: Behaviour = 'reply'): void {
    FakeWorker.instances = [];
    FakeWorker.behaviour = behaviour;
  }

  static create = (): Worker => new FakeWorker() as unknown as Worker;

  postMessage(message: WorkerRequest): void {
    this.posted.push(message);
    if (this.behaviour !== 'reply' || message.type === 'cancel') return;
    queueMicrotask(() => this.answer(message.id));
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
        : { type: 'result' as const, result: { name: request?.type === 'analyze' ? request.name : '' } as never };
    this.onmessage?.({ data: { v: 1, id, ...base, ...reply } as WorkerResponse });
  }

  crash(message = 'boom'): void {
    this.onerror?.({ message });
  }
}

export const analyzeRequest = (name: string) => ({ type: 'analyze' as const, file: new Blob([new Uint8Array(8)]), name, engine: 'own' as const, options: {} });
