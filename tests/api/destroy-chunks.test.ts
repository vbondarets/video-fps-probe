import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineModule } from '../../src/plugins/types.ts';
import { FakeWorker } from './fake-worker.ts';
import { customWorker, fakeModule, mp4File, webmFile } from './probe-helpers.ts';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T = void>(): Deferred<T> {
  const d = {} as Deferred<T>;
  d.promise = new Promise<T>((resolve, reject) => Object.assign(d, { resolve, reject }));
  d.promise.catch(() => {});
  return d;
}

const aborted = { name: 'ProbeError', code: 'aborted' };
const fetchFailed = () => new TypeError('Failed to fetch dynamically imported module');
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settledByNextTick = <T>(p: Promise<T>): Promise<T> => Promise.race([p, tick().then(() => Promise.reject(new Error('still pending on the next tick')))]);

type Gates = Partial<Record<'compare' | 'fallback' | 'inline' | 'route', Promise<unknown>>>;

async function loadProbe(gates: Gates = {}) {
  vi.resetModules();
  vi.doMock('../../src/client/compare.ts', async (importOriginal) => {
    await gates.compare;
    return importOriginal();
  });
  vi.doMock('../../src/client/fallback.ts', async (importOriginal) => {
    await gates.fallback;
    return importOriginal();
  });
  vi.doMock('../../src/client/inline.ts', async (importOriginal) => {
    await gates.inline;
    return importOriginal();
  });
  vi.doMock('../../src/client/route.ts', async (importOriginal) => {
    await gates.route;
    return importOriginal();
  });
  return (await import('../../src/client/create.ts')).createProbeClient;
}

const failedChunk = () => {
  const chunk = deferred();
  chunk.reject(fetchFailed());
  return chunk.promise;
};

beforeEach(() => {
  FakeWorker.reset();
  vi.stubGlobal('Worker', FakeWorker);
});

afterEach(async () => {
  await vi.dynamicImportSettled();
  vi.doUnmock('../../src/client/compare.ts');
  vi.doUnmock('../../src/client/fallback.ts');
  vi.doUnmock('../../src/client/inline.ts');
  vi.doUnmock('../../src/client/route.ts');
  vi.unstubAllGlobals();
});

describe('destroy while a lazy chunk loads', () => {
  it('rejects a compare waiting for the compare chunk with aborted at once, and no engine runs when the chunk arrives', async () => {
    const chunk = deferred();
    const createProbeClient = await loadProbe({ compare: chunk.promise });
    const probe = createProbeClient({ worker: customWorker('own', 'mp4box') });
    const pending = probe.compare(mp4File());
    probe.destroy();
    await expect(settledByNextTick(pending)).rejects.toMatchObject(aborted);
    chunk.resolve();
    await tick();
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it('rejects a fallback call with aborted, not the load error, when the fallback chunk fails to load after destroy', async () => {
    const chunk = deferred();
    const createProbeClient = await loadProbe({ fallback: chunk.promise });
    const probe = createProbeClient({ worker: customWorker('own', 'mp4box') });
    const pending = probe.analyze(mp4File(), { fallback: ['mp4box'] });
    probe.destroy();
    chunk.reject(fetchFailed());
    await expect(settledByNextTick(pending)).rejects.toMatchObject(aborted);
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it('rejects calls made after destroy with aborted when their chunks fail to load', async () => {
    const createProbeClient = await loadProbe({ compare: failedChunk(), fallback: failedChunk() });
    const probe = createProbeClient({ worker: customWorker('own', 'mp4box') });
    probe.destroy();
    await expect(probe.compare(mp4File())).rejects.toMatchObject(aborted);
    await expect(probe.analyze(mp4File(), { fallback: ['mp4box'] })).rejects.toMatchObject(aborted);
    await tick();
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it('still reports a chunk that fails to load before destroy as worker-failed', async () => {
    const createProbeClient = await loadProbe({ fallback: failedChunk() });
    const probe = createProbeClient({ worker: customWorker('own', 'mp4box') });
    await expect(probe.analyze(mp4File(), { fallback: ['mp4box'] })).rejects.toMatchObject({ name: 'ProbeError', code: 'worker-failed', reason: 'load' });
    expect(await probe.tryAnalyze(mp4File(), { fallback: ['mp4box'] })).toBeNull();
  });

  it('rejects an own analysis waiting for the split routing chunk of byContainer with aborted at once, and no worker starts when it arrives', async () => {
    const chunk = deferred();
    const createProbeClient = await loadProbe({ route: chunk.promise });
    const probe = createProbeClient({ worker: { ...customWorker('own'), byContainer: { matroska: FakeWorker.as('matroska') } } });
    const pending = probe.analyze(webmFile());
    probe.destroy();
    await expect(settledByNextTick(pending)).rejects.toMatchObject({ ...aborted, engine: 'own' });
    chunk.resolve();
    await tick();
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it('reports a split routing chunk that fails to load as worker-failed, with reason load', async () => {
    const createProbeClient = await loadProbe({ route: failedChunk() });
    const probe = createProbeClient({ worker: { ...customWorker('own'), byContainer: { matroska: FakeWorker.as('matroska') } } });
    await expect(probe.analyze(webmFile())).rejects.toMatchObject({ name: 'ProbeError', code: 'worker-failed', reason: 'load', engine: 'own' });
    expect(await probe.tryAnalyze(mp4File())).toBeNull();
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it('rejects a main-thread engine run waiting for the in-thread runner chunk with aborted at once, and the engine never runs', async () => {
    const chunk = deferred();
    const createProbeClient = await loadProbe({ inline: chunk.promise });
    const module = fakeModule('rvfc');
    const probe = createProbeClient({ worker: customWorker('own'), engines: [{ id: 'rvfc', thread: 'main', load: async () => module }] });
    const pending = probe.analyze(mp4File(), { engine: 'rvfc' });
    probe.destroy();
    await expect(settledByNextTick(pending)).rejects.toMatchObject({ ...aborted, engine: 'rvfc' });
    chunk.resolve();
    await tick();
    expect(module.calls).toEqual([]);
  });

  it('resolves a prewarm waiting for a main-thread engine module at once and skips warming when the module arrives', async () => {
    const load = deferred<EngineModule>();
    const warm = vi.fn(async () => {});
    const createProbeClient = await loadProbe();
    const probe = createProbeClient({ worker: customWorker('own'), engines: [{ id: 'rvfc', thread: 'main', load: () => load.promise }] });
    const pending = probe.prewarm({ engines: ['rvfc'] });
    probe.destroy();
    await expect(settledByNextTick(pending)).resolves.toBeUndefined();
    load.resolve({ ...fakeModule('rvfc'), warm });
    await tick();
    expect(warm).not.toHaveBeenCalled();
  });

  it('resolves a prewarm whose engine module fails to load after destroy, and a prewarm after destroy loads nothing', async () => {
    const load = deferred<EngineModule>();
    const loads = vi.fn(() => load.promise);
    const createProbeClient = await loadProbe();
    const probe = createProbeClient({ worker: customWorker('own'), engines: [{ id: 'rvfc', thread: 'main', load: loads }] });
    const pending = probe.prewarm({ engines: ['rvfc'] });
    probe.destroy();
    load.reject(fetchFailed());
    await expect(settledByNextTick(pending)).resolves.toBeUndefined();
    await expect(probe.prewarm({ engines: ['own', 'rvfc'] })).resolves.toBeUndefined();
    expect(loads).toHaveBeenCalledTimes(1);
    expect(FakeWorker.instances).toHaveLength(0);
  });
});
