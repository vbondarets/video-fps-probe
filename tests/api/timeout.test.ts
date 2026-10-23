import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isTimeoutError } from '../../src/api/errors.ts';
import { WorkerPool } from '../../src/client/pool.ts';
import { analyzeRequest, FakeWorker } from './fake-worker.ts';

beforeEach(() => {
  vi.useFakeTimers();
  FakeWorker.reset('hang');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('per-attempt timeout', () => {
  it('rejects with ProbeError timeout and terminates the stuck worker immediately', async () => {
    const pool = new WorkerPool({ create: FakeWorker.create });
    const run = pool.run(analyzeRequest('a'), { timeoutMs: 3000, engine: 'own' });
    const settled = run.catch((e: unknown) => e);
    vi.advanceTimersByTime(2999);
    expect(FakeWorker.instances[0].terminated).toBe(false);
    vi.advanceTimersByTime(1);
    expect(FakeWorker.instances[0].terminated).toBe(true);
    const error = await settled;
    expect(isTimeoutError(error)).toBe(true);
    expect(error).toMatchObject({ code: 'timeout', engine: 'own', message: 'timed out after 3000 ms' });
    expect(pool.workers).toBe(0);
  });

  it('counts from dispatch to a worker, not from the call, and respawns lazily for the next job', async () => {
    const pool = new WorkerPool({ create: FakeWorker.create });
    const first = pool.run(analyzeRequest('a'), { timeoutMs: 100 }).catch((e: unknown) => e);
    const second = pool.run(analyzeRequest('b'), { timeoutMs: 100 }).catch((e: unknown) => e);
    expect(FakeWorker.instances).toHaveLength(1);
    vi.advanceTimersByTime(100);
    expect(await first).toMatchObject({ code: 'timeout' });
    expect(FakeWorker.instances).toHaveLength(2);
    expect(FakeWorker.instances[1].pending.map((m) => m.id)).toEqual([2]);
    vi.advanceTimersByTime(99);
    expect(FakeWorker.instances[1].terminated).toBe(false);
    vi.advanceTimersByTime(1);
    expect(await second).toMatchObject({ code: 'timeout' });
    expect(FakeWorker.instances[1].terminated).toBe(true);
  });

  it('does not fire after the worker answered in time', async () => {
    FakeWorker.reset('manual');
    const pool = new WorkerPool({ create: FakeWorker.create, idleTimeoutMs: 0 });
    const run = pool.run(analyzeRequest('a'), { timeoutMs: 100 });
    FakeWorker.instances[0].answer(1);
    expect(await run).toMatchObject({ type: 'result' });
    vi.advanceTimersByTime(1000);
    expect(FakeWorker.instances[0].terminated).toBe(false);
  });

  it('applies no timeout without timeoutMs', async () => {
    const pool = new WorkerPool({ create: FakeWorker.create, idleTimeoutMs: 0 });
    let settled = false;
    void pool.run(analyzeRequest('a')).finally(() => (settled = true));
    vi.advanceTimersByTime(60 * 60_000);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(FakeWorker.instances[0].terminated).toBe(false);
  });
});
