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
    const { v, id } = message;
    if (message.type === 'analyze') {
      const { name } = message;
      queueMicrotask(() => this.onmessage?.({ data: { v, type: 'result', id, result: { name } } }));
    } else if (message.type === 'warm') {
      queueMicrotask(() => this.onmessage?.({ data: { v, type: 'warmed', id } }));
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
  it('prewarm spawns one worker and sends a warm request for the own ISO BMFF parser; dispose terminates idle workers', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    vi.resetModules();
    const pool = await import('../../src/ui/workerPool.ts');
    await pool.prewarm();
    expect(FakeWorker.instances).toHaveLength(1);
    const [request] = FakeWorker.instances[0].posted;
    expect(request).toEqual({ v: 1, type: 'warm', id: request.id, engines: ['own'], containers: ['isobmff'] });
    const result = await pool.submit(new File([new Uint8Array(8)], 'a.mp4'), 'own', {}).promise;
    expect(result.name).toBe('a.mp4');
    const analyze = FakeWorker.instances[0].posted[1];
    expect(analyze).toMatchObject({ v: 1, type: 'analyze', name: 'a.mp4', engine: 'own' });
    expect(FakeWorker.instances).toHaveLength(1);
    pool.dispose();
    expect(FakeWorker.instances[0].terminated).toBe(true);
    await pool.submit(new File([new Uint8Array(8)], 'b.mp4'), 'own', {}).promise;
    expect(FakeWorker.instances).toHaveLength(2);
  });
});

describe('worker pool chunk loading', () => {
  afterEach(() => {
    vi.doUnmock('../../src/client/pool.ts');
  });

  it('retries the pool chunk import on the next submit after a failed fetch', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    vi.resetModules();
    let attempts = 0;
    vi.doMock('../../src/client/pool.ts', async (importOriginal) => {
      attempts++;
      if (attempts === 1) throw new TypeError('Failed to fetch dynamically imported module');
      return importOriginal();
    });
    const pool = await import('../../src/ui/workerPool.ts');
    await expect(pool.submit(new File([new Uint8Array(8)], 'a.mp4'), 'own', {}).promise).rejects.toBeInstanceOf(Error);
    expect(FakeWorker.instances).toHaveLength(0);
    const result = await pool.submit(new File([new Uint8Array(8)], 'b.mp4'), 'own', {}).promise;
    expect(result.name).toBe('b.mp4');
    expect(attempts).toBe(2);
    expect(FakeWorker.instances).toHaveLength(1);
  });
});
