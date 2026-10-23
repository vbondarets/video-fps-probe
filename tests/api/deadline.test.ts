import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isAbortError } from '../../src/api/errors.ts';
import { KILL_AFTER_MS, WorkerPool } from '../../src/client/pool.ts';
import { analyzeRequest, FakeWorker } from './fake-worker.ts';

beforeEach(() => {
  vi.useFakeTimers();
  FakeWorker.reset('hang');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('shared deadline for a batch', () => {
  it('settles 10 queued hanging files within the shared signal deadline', async () => {
    const pool = new WorkerPool({ create: FakeWorker.create, size: 2 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5000);
    const settledAt: number[] = [];
    const runs = Array.from({ length: 10 }, (_, i) =>
      pool.run(analyzeRequest(`${i}.mp4`), { signal: controller.signal, timeoutMs: 3000 }).catch((e: unknown) => {
        settledAt.push(Date.now());
        return e;
      }),
    );
    const t0 = Date.now();
    await vi.advanceTimersByTimeAsync(5000);
    const errors = await Promise.all(runs);
    expect(settledAt).toHaveLength(10);
    expect(Math.max(...settledAt) - t0).toBeLessThanOrEqual(5000);
    expect(errors.every((e) => isAbortError(e) || (e as { code?: string }).code === 'timeout')).toBe(true);
    expect(errors.filter(isAbortError).length).toBeGreaterThan(0);
  });

  it('frees the slots of aborted running jobs once the stuck workers are killed', async () => {
    const pool = new WorkerPool({ create: FakeWorker.create, size: 2 });
    const controller = new AbortController();
    const runs = Array.from({ length: 10 }, (_, i) => pool.run(analyzeRequest(`${i}.mp4`), { signal: controller.signal }).catch((e: unknown) => e));
    expect(FakeWorker.instances).toHaveLength(2);
    controller.abort();
    expect((await Promise.all(runs)).every(isAbortError)).toBe(true);
    expect(FakeWorker.instances.every((w) => w.posted.filter((m) => m.type === 'analyze').length === 1)).toBe(true);
    await vi.advanceTimersByTimeAsync(KILL_AFTER_MS);
    expect(FakeWorker.instances.every((w) => w.terminated)).toBe(true);
    expect(pool.workers).toBe(0);
  });
});
