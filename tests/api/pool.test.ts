import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProbeError } from '../../src/api/errors.ts';
import { KILL_AFTER_MS, WorkerPool } from '../../src/client/pool.ts';
import { analyzeRequest, FakeWorker } from './fake-worker.ts';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => FakeWorker.reset());

afterEach(() => {
  vi.useRealTimers();
});

describe('WorkerPool', () => {
  it('warms and analyzes on one worker, dispose terminates idle workers and the next job respawns', async () => {
    const pool = new WorkerPool({ create: FakeWorker.create, idleTimeoutMs: 0 });
    expect(await pool.run({ type: 'warm', engines: ['own'], containers: ['isobmff'] })).toMatchObject({ type: 'warmed' });
    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0].posted[0]).toEqual({ v: 1, id: 1, type: 'warm', engines: ['own'], containers: ['isobmff'] });
    const reply = await pool.run(analyzeRequest('a.mp4'));
    expect(reply).toMatchObject({ type: 'result', result: { name: 'a.mp4' } });
    expect(FakeWorker.instances).toHaveLength(1);
    pool.dispose();
    expect(FakeWorker.instances[0].terminated).toBe(true);
    expect(pool.workers).toBe(0);
    await pool.run(analyzeRequest('b.mp4'));
    expect(FakeWorker.instances).toHaveLength(2);
  });

  it('spawns up to size workers and queues the rest', async () => {
    FakeWorker.reset('manual');
    const pool = new WorkerPool({ create: FakeWorker.create, size: 2, idleTimeoutMs: 0 });
    const runs = ['a', 'b', 'c'].map((n) => pool.run(analyzeRequest(n)));
    expect(FakeWorker.instances).toHaveLength(2);
    const [w1, w2] = FakeWorker.instances;
    expect(w1.pending.map((m) => m.id)).toEqual([1]);
    expect(w2.pending.map((m) => m.id)).toEqual([2]);
    w2.answer(2);
    expect(w2.pending.map((m) => m.id)).toEqual([2, 3]);
    w1.answer(1);
    w2.answer(3);
    expect((await Promise.all(runs)).map((r) => r.type)).toEqual(['result', 'result', 'result']);
    expect(FakeWorker.instances).toHaveLength(2);
  });

  it('resolves skipped replies and maps worker errors to ProbeError codes with the engine', async () => {
    FakeWorker.reset('manual');
    const pool = new WorkerPool({ create: FakeWorker.create, size: 4, idleTimeoutMs: 0 });
    const skipped = pool.run(analyzeRequest('a.webm'), { engine: 'mp4box' });
    const unknown = pool.run(analyzeRequest('b'), { engine: 'mediabunny' });
    const failed = pool.run(analyzeRequest('c'), { engine: 'mp4box' });
    const protocol = pool.run(analyzeRequest('d'));
    const [w1, w2, w3, w4] = FakeWorker.instances;
    w1.answer(1, { type: 'skipped', reason: 'unsupported-container' });
    w2.answer(2, { type: 'error', message: 'unknown engine mediabunny', aborted: false, code: 'unknown-engine' });
    w3.answer(3, { type: 'error', message: 'Failed to fetch dynamically imported module', aborted: false });
    w4.answer(4, { type: 'error', message: 'unsupported protocol version', aborted: false, code: 'protocol' });
    expect(await skipped).toMatchObject({ type: 'skipped', reason: 'unsupported-container' });
    await expect(unknown).rejects.toMatchObject({ name: 'ProbeError', code: 'unknown-engine', engine: 'mediabunny', message: 'unknown engine mediabunny' });
    await expect(failed).rejects.toMatchObject({ code: 'worker-failed', engine: 'mp4box', message: 'Failed to fetch dynamically imported module' });
    await expect(protocol).rejects.toMatchObject({ code: 'protocol', engine: null });
  });

  it('forwards progress for the running job only', async () => {
    FakeWorker.reset('manual');
    const pool = new WorkerPool({ create: FakeWorker.create, idleTimeoutMs: 0 });
    const seen: number[] = [];
    const run = pool.run(analyzeRequest('a'), { onProgress: (p) => seen.push(p.done) });
    const [w] = FakeWorker.instances;
    w.answer(1, { type: 'progress', progress: { phase: 'scan', done: 1, total: 2 } });
    w.answer(99, { type: 'progress', progress: { phase: 'scan', done: 7, total: 9 } });
    w.answer(1);
    await run;
    expect(seen).toEqual([1]);
  });

  it('rejects a worker crash with worker-failed, discards that worker and respawns for the next job', async () => {
    FakeWorker.reset('manual');
    const pool = new WorkerPool({ create: FakeWorker.create, idleTimeoutMs: 0 });
    const first = pool.run(analyzeRequest('a'), { engine: 'own' });
    const second = pool.run(analyzeRequest('b'));
    FakeWorker.instances[0].crash('script error');
    await expect(first).rejects.toMatchObject({ code: 'worker-failed', engine: 'own', message: 'script error' });
    expect(FakeWorker.instances[0].terminated).toBe(true);
    expect(FakeWorker.instances).toHaveLength(2);
    FakeWorker.instances[1].answer(2);
    expect(await second).toMatchObject({ type: 'result' });
  });

  it('rejects with worker-failed when the worker cannot be created', async () => {
    const pool = new WorkerPool({
      create: () => {
        throw new Error('blocked by CSP');
      },
    });
    const run = pool.run(analyzeRequest('a'), { engine: 'own' });
    await expect(run).rejects.toBeInstanceOf(ProbeError);
    await expect(run).rejects.toMatchObject({ code: 'worker-failed', engine: 'own' });
  });

  it('rejects an already aborted signal without spawning a worker', async () => {
    const pool = new WorkerPool({ create: FakeWorker.create });
    const controller = new AbortController();
    controller.abort();
    await expect(pool.run(analyzeRequest('a'), { signal: controller.signal })).rejects.toMatchObject({ code: 'aborted' });
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it('removes an aborted queued job at once and never posts it', async () => {
    FakeWorker.reset('manual');
    const pool = new WorkerPool({ create: FakeWorker.create, idleTimeoutMs: 0 });
    const running = pool.run(analyzeRequest('a'));
    const controller = new AbortController();
    const queued = pool.run(analyzeRequest('b'), { signal: controller.signal });
    controller.abort();
    await expect(queued).rejects.toMatchObject({ code: 'aborted' });
    FakeWorker.instances[0].answer(1);
    await running;
    await flush();
    expect(FakeWorker.instances[0].posted.map((m) => m.id)).toEqual([1]);
  });

  it('rejects an aborted running job at once, sends cancel and reuses the slot once the worker replies', async () => {
    FakeWorker.reset('manual');
    const pool = new WorkerPool({ create: FakeWorker.create, idleTimeoutMs: 0 });
    const controller = new AbortController();
    const run = pool.run(analyzeRequest('a'), { signal: controller.signal });
    const next = pool.run(analyzeRequest('b'));
    const [w] = FakeWorker.instances;
    controller.abort();
    await expect(run).rejects.toMatchObject({ code: 'aborted' });
    expect(w.posted.at(-1)).toEqual({ v: 1, type: 'cancel', id: 1 });
    expect(w.pending.map((m) => m.id)).toEqual([1]);
    w.answer(1, { type: 'error', message: 'Aborted', aborted: true });
    expect(w.pending.map((m) => m.id)).toEqual([1, 2]);
    w.answer(2);
    expect(await next).toMatchObject({ type: 'result' });
    expect(FakeWorker.instances).toHaveLength(1);
  });

  it('terminates a worker that ignores cancel after KILL_AFTER_MS and runs the queue on a new one', async () => {
    vi.useFakeTimers();
    FakeWorker.reset('manual');
    const pool = new WorkerPool({ create: FakeWorker.create, idleTimeoutMs: 0 });
    const controller = new AbortController();
    const run = pool.run(analyzeRequest('a'), { signal: controller.signal });
    const next = pool.run(analyzeRequest('b'));
    controller.abort();
    await expect(run).rejects.toMatchObject({ code: 'aborted' });
    vi.advanceTimersByTime(KILL_AFTER_MS - 1);
    expect(FakeWorker.instances[0].terminated).toBe(false);
    vi.advanceTimersByTime(1);
    expect(FakeWorker.instances[0].terminated).toBe(true);
    expect(FakeWorker.instances).toHaveLength(2);
    FakeWorker.instances[1].answer(2);
    expect(await next).toMatchObject({ type: 'result' });
  });

  it('terminates idle workers after idleTimeoutMs and respawns lazily', async () => {
    vi.useFakeTimers();
    const pool = new WorkerPool({ create: FakeWorker.create, idleTimeoutMs: 30_000 });
    await pool.run(analyzeRequest('a'));
    vi.advanceTimersByTime(29_999);
    expect(FakeWorker.instances[0].terminated).toBe(false);
    await pool.run(analyzeRequest('b'));
    vi.advanceTimersByTime(29_999);
    expect(FakeWorker.instances[0].terminated).toBe(false);
    vi.advanceTimersByTime(1);
    expect(FakeWorker.instances[0].terminated).toBe(true);
    expect(pool.workers).toBe(0);
    await pool.run(analyzeRequest('c'));
    expect(FakeWorker.instances).toHaveLength(2);
  });

  it('keeps idle workers alive with idleTimeoutMs 0', async () => {
    vi.useFakeTimers();
    const pool = new WorkerPool({ create: FakeWorker.create, idleTimeoutMs: 0 });
    await pool.run(analyzeRequest('a'));
    vi.advanceTimersByTime(10 * 60_000);
    expect(FakeWorker.instances[0].terminated).toBe(false);
  });

  it('treats a non-finite or too large timeoutMs as no timeout and a non-finite idleTimeoutMs as keep alive', async () => {
    FakeWorker.reset('manual');
    const pool = new WorkerPool({ create: FakeWorker.create, size: 3, idleTimeoutMs: Number.POSITIVE_INFINITY });
    const settled: string[] = [];
    const runs = [Number.POSITIVE_INFINITY, Number.NaN, 2 ** 31].map((timeoutMs, i) =>
      pool.run(analyzeRequest(String(i)), { timeoutMs }).then(
        () => settled.push(String(i)),
        (e: unknown) => settled.push(`failed ${i}: ${String(e)}`),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toEqual([]);
    expect(FakeWorker.instances.map((w) => w.terminated)).toEqual([false, false, false]);
    FakeWorker.instances.forEach((w, i) => w.answer(i + 1));
    await Promise.all(runs);
    expect(settled.sort()).toEqual(['0', '1', '2']);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pool.workers).toBe(3);
    expect(FakeWorker.instances.map((w) => w.terminated)).toEqual([false, false, false]);
  });

  it('falls back to one worker for a size that is not a finite number of at least 1 and rounds a fractional size down', async () => {
    for (const size of [Number.NaN, 0, -2, Number.POSITIVE_INFINITY]) {
      FakeWorker.reset('manual');
      const pool = new WorkerPool({ create: FakeWorker.create, size, idleTimeoutMs: 0 });
      const runs = [pool.run(analyzeRequest('a')), pool.run(analyzeRequest('b'))];
      expect(FakeWorker.instances).toHaveLength(1);
      FakeWorker.instances[0].answer(1);
      FakeWorker.instances[0].answer(2);
      expect((await Promise.all(runs)).map((r) => r.type)).toEqual(['result', 'result']);
    }
    FakeWorker.reset('manual');
    const pool = new WorkerPool({ create: FakeWorker.create, size: 2.7, idleTimeoutMs: 0 });
    const runs = ['a', 'b', 'c'].map((n) => pool.run(analyzeRequest(n)).catch((e: unknown) => e));
    expect(FakeWorker.instances).toHaveLength(2);
    pool.destroy();
    expect(await Promise.all(runs)).toMatchObject([{ code: 'aborted' }, { code: 'aborted' }, { code: 'aborted' }]);
  });

  it('destroy rejects queued and running jobs as aborted and terminates every worker', async () => {
    FakeWorker.reset('manual');
    const pool = new WorkerPool({ create: FakeWorker.create, size: 2 });
    const runs = ['a', 'b', 'c'].map((n) => pool.run(analyzeRequest(n), { engine: 'own' }));
    pool.destroy();
    for (const run of runs) await expect(run).rejects.toMatchObject({ code: 'aborted', engine: 'own' });
    expect(FakeWorker.instances.map((w) => w.terminated)).toEqual([true, true]);
    expect(pool.workers).toBe(0);
  });
});
