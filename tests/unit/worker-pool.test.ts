import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkerRequest } from '../../src/worker/protocol.ts';

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  posted: WorkerRequest[] = [];
  terminated = false;

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(message: WorkerRequest): void {
    this.posted.push(message);
    if (message.type === 'analyze') {
      const { id, file } = message;
      queueMicrotask(() => this.onmessage?.({ data: { type: 'result', id, result: { name: file.name } } }));
    }
  }

  terminate(): void {
    this.terminated = true;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeWorker.instances = [];
});

describe('worker pool lifecycle for embedding', () => {
  it('prewarm spawns one worker and runs a 16-byte ftyp through the own parser; dispose terminates idle workers', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    vi.resetModules();
    const pool = await import('../../src/ui/workerPool.ts');
    await pool.prewarm();
    expect(FakeWorker.instances).toHaveLength(1);
    const [request] = FakeWorker.instances[0].posted;
    expect(request.type).toBe('analyze');
    if (request.type !== 'analyze') return;
    expect(request.engine).toBe('own');
    expect(request.file.size).toBe(16);
    expect(new TextDecoder().decode((await request.file.arrayBuffer()).slice(4, 8))).toBe('ftyp');
    await pool.submit(new File([new Uint8Array(8)], 'a.mp4'), 'own', {}).promise;
    expect(FakeWorker.instances).toHaveLength(1);
    pool.dispose();
    expect(FakeWorker.instances[0].terminated).toBe(true);
    await pool.submit(new File([new Uint8Array(8)], 'b.mp4'), 'own', {}).promise;
    expect(FakeWorker.instances).toHaveLength(2);
  });
});
