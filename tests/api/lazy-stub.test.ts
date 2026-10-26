import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProbeError } from '../../src/api/errors.ts';
import type { EngineId } from '../../src/core/types.ts';
import type { Probe } from '../../src/client/types.ts';
import { fakeResult, FakeWorker } from './fake-worker.ts';
import { customWorker, foreignProbeError, mainDescriptor, mp4File, workerDescriptor } from './probe-helpers.ts';

const loads = vi.hoisted(() => ({ root: 0, client: 0 }));

vi.mock('../../src/probe.ts', async (importOriginal) => {
  loads.root++;
  return importOriginal();
});

vi.mock('../../src/client/probe.ts', async (importOriginal) => {
  loads.client++;
  return importOriginal();
});

import { lazyProbeClient, lazyProbeFrom } from '../../src/client/lazy.ts';
import { lazyProbe, lazyProbeFrom as fromLazyEntry } from '../../src/lazy.ts';

const settledByNextTick = <T>(p: Promise<T>): Promise<T> =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('still pending on the next tick')), 0))]);

function fakeProbe(): Probe<EngineId> & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    engines: ['own', 'mp4box'],
    analyze: async (file) => (calls.push('analyze'), fakeResult(file instanceof File ? file.name : '')),
    tryAnalyze: async () => (calls.push('tryAnalyze'), null),
    compare: async () => (calls.push('compare'), { name: '', size: 0, reference: null, outcomes: {}, agreement: { reference: null, engines: [], fields: [], agree: null } }),
    prewarm: async () => void calls.push('prewarm'),
    dispose: () => void calls.push('dispose'),
    destroy: () => void calls.push('destroy'),
  };
}

beforeEach(() => {
  FakeWorker.reset();
  vi.stubGlobal('Worker', FakeWorker);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('lazyProbeFrom', () => {
  it('does nothing until used, then loads once and forwards every call', async () => {
    const probe = fakeProbe();
    const factory = vi.fn(async () => probe);
    const stub = lazyProbeFrom(factory);
    expect(stub.loaded).toBe(false);
    expect(stub.engines).toEqual([]);
    stub.dispose();
    expect(factory).not.toHaveBeenCalled();
    const [a, b] = await Promise.all([stub.analyze(mp4File('a.mp4')), stub.analyze(mp4File('b.mp4'))]);
    expect([a.name, b.name]).toEqual(['a.mp4', 'b.mp4']);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(stub.loaded).toBe(true);
    expect(stub.engines).toEqual(['own', 'mp4box']);
    expect(await stub.load()).toBe(probe);
    await stub.tryAnalyze(mp4File());
    await stub.compare(mp4File());
    await stub.prewarm();
    stub.dispose();
    stub.destroy();
    expect(probe.calls).toEqual(['analyze', 'analyze', 'tryAnalyze', 'compare', 'prewarm', 'dispose', 'destroy']);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('retries the factory on the next call after a failed load; tryAnalyze and prewarm never reject', async () => {
    const probe = fakeProbe();
    const factory = vi
      .fn<() => Promise<Probe<EngineId>>>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch dynamically imported module'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch dynamically imported module'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch dynamically imported module'))
      .mockResolvedValue(probe);
    const stub = lazyProbeFrom(factory);
    const failed = await stub.analyze(mp4File()).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(ProbeError);
    expect(failed).toMatchObject({ name: 'ProbeError', code: 'worker-failed', engine: null, reason: 'load', message: 'TypeError: Failed to fetch dynamically imported module' });
    expect((failed as ProbeError).cause).toBeInstanceOf(TypeError);
    expect(stub.loaded).toBe(false);
    expect(await stub.tryAnalyze(mp4File())).toBeNull();
    await expect(stub.prewarm()).resolves.toBeUndefined();
    expect((await stub.analyze(mp4File('d.mp4'))).name).toBe('d.mp4');
    expect(factory).toHaveBeenCalledTimes(4);
    expect(stub.loaded).toBe(true);
  });

  it('rejects the calls waiting for the load with aborted when destroyed while loading, destroys the probe it loads, and rejects every call after it', async () => {
    const probe = fakeProbe();
    let resolve: ((p: Probe<EngineId>) => void) | null = null;
    const stub = lazyProbeFrom(() => new Promise<Probe<EngineId>>((r) => (resolve = r)));
    const analyzed = stub.analyze(mp4File('a.mp4'));
    const compared = stub.compare(mp4File('a.mp4'));
    const tried = stub.tryAnalyze(mp4File('b.mp4'));
    const warmed = stub.prewarm();
    stub.destroy();
    resolve!(probe);
    await expect(analyzed).rejects.toMatchObject({ name: 'ProbeError', code: 'aborted' });
    await expect(compared).rejects.toMatchObject({ name: 'ProbeError', code: 'aborted' });
    expect(await tried).toBeNull();
    await expect(warmed).resolves.toBeUndefined();
    expect(stub.loaded).toBe(true);
    expect(probe.calls).toEqual(['destroy']);
    await expect(stub.analyze(mp4File('c.mp4'))).rejects.toMatchObject({ name: 'ProbeError', code: 'aborted' });
    await expect(stub.compare(mp4File('c.mp4'))).rejects.toMatchObject({ name: 'ProbeError', code: 'aborted' });
    expect(await stub.tryAnalyze(mp4File('c.mp4'))).toBeNull();
    await expect(stub.prewarm()).resolves.toBeUndefined();
    expect(probe.calls).toEqual(['destroy']);
  });

  it('rejects the calls waiting for a load still in flight with aborted at once on destroy, without waiting for the factory', async () => {
    const probe = fakeProbe();
    let resolve: ((p: Probe<EngineId>) => void) | null = null;
    const stub = lazyProbeFrom(() => new Promise<Probe<EngineId>>((r) => (resolve = r)));
    const loading = stub.load();
    const analyzed = stub.analyze(mp4File('a.mp4'));
    const compared = stub.compare(mp4File('a.mp4'));
    const tried = stub.tryAnalyze(mp4File('b.mp4'));
    const warmed = stub.prewarm();
    stub.destroy();
    await expect(settledByNextTick(analyzed)).rejects.toMatchObject({ name: 'ProbeError', code: 'aborted' });
    await expect(settledByNextTick(compared)).rejects.toMatchObject({ name: 'ProbeError', code: 'aborted' });
    expect(await settledByNextTick(tried)).toBeNull();
    await expect(settledByNextTick(warmed)).resolves.toBeUndefined();
    expect(stub.loaded).toBe(false);
    resolve!(probe);
    expect(await loading).toBe(probe);
    expect(probe.calls).toEqual(['destroy']);
  });

  it('rejects the calls waiting for a load with aborted, not the load error, when the factory fails after destroy', async () => {
    let reject: ((e: unknown) => void) | null = null;
    const stub = lazyProbeFrom(() => new Promise<Probe<EngineId>>((_, r) => (reject = r)));
    const analyzed = stub.analyze(mp4File('a.mp4'));
    const compared = stub.compare(mp4File('a.mp4'));
    const tried = stub.tryAnalyze(mp4File('b.mp4'));
    const warmed = stub.prewarm();
    stub.destroy();
    reject!(new TypeError('Failed to fetch dynamically imported module'));
    await expect(analyzed).rejects.toMatchObject({ name: 'ProbeError', code: 'aborted' });
    await expect(compared).rejects.toMatchObject({ name: 'ProbeError', code: 'aborted' });
    expect(await tried).toBeNull();
    await expect(warmed).resolves.toBeUndefined();
    expect(stub.loaded).toBe(false);
  });

  it('destroyed before any use, never loads and rejects every call with aborted', async () => {
    const factory = vi.fn(async () => fakeProbe());
    const stub = lazyProbeFrom(factory);
    stub.destroy();
    await expect(stub.analyze(mp4File())).rejects.toMatchObject({ name: 'ProbeError', code: 'aborted' });
    await expect(stub.compare(mp4File())).rejects.toMatchObject({ name: 'ProbeError', code: 'aborted' });
    expect(await stub.tryAnalyze(mp4File())).toBeNull();
    await expect(stub.prewarm()).resolves.toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
    expect(stub.loaded).toBe(false);
  });

  it('a loaded stub destroyed once rejects the calls after it without forwarding them', async () => {
    const probe = fakeProbe();
    const stub = lazyProbeFrom(async () => probe);
    await stub.load();
    stub.destroy();
    await expect(stub.analyze(mp4File())).rejects.toMatchObject({ name: 'ProbeError', code: 'aborted' });
    expect(await stub.tryAnalyze(mp4File())).toBeNull();
    expect(probe.calls).toEqual(['destroy']);
  });

  it('forwards a call to a loaded probe at once, so a destroy right after it reaches the probe second', async () => {
    const probe = fakeProbe();
    const stub = lazyProbeFrom(async () => probe);
    await stub.load();
    const pending = stub.analyze(mp4File('a.mp4'));
    stub.destroy();
    await pending;
    expect(probe.calls).toEqual(['analyze', 'destroy']);
  });

  it('turns a factory that throws synchronously into rejections; tryAnalyze and prewarm still resolve and the next call retries', async () => {
    const probe = fakeProbe();
    const factory = vi.fn((): Promise<Probe<EngineId>> => {
      if (factory.mock.calls.length <= 4) throw new TypeError('factory threw');
      return Promise.resolve(probe);
    });
    const stub = lazyProbeFrom(factory);
    const loading = stub.load();
    expect(loading).toBeInstanceOf(Promise);
    await expect(loading).rejects.toMatchObject({ code: 'worker-failed', reason: 'load', message: 'TypeError: factory threw' });
    await expect(stub.analyze(mp4File())).rejects.toMatchObject({ code: 'worker-failed', reason: 'load', message: 'TypeError: factory threw' });
    expect(await stub.tryAnalyze(mp4File())).toBeNull();
    await expect(stub.prewarm()).resolves.toBeUndefined();
    expect(stub.loaded).toBe(false);
    expect((await stub.compare(mp4File())).name).toBe('');
    expect(factory).toHaveBeenCalledTimes(5);
  });

  it('passes a ProbeError of the factory through as it is, for example an option error of the probe it creates', async () => {
    const option = new ProbeError('engine-not-registered', 'engine mp4box is not registered', { engine: 'mp4box' });
    const factory = vi.fn<() => Promise<Probe<EngineId>>>().mockRejectedValue(option);
    const stub = lazyProbeFrom(factory);
    await expect(stub.load()).rejects.toBe(option);
    await expect(stub.analyze(mp4File())).rejects.toBe(option);
    expect('reason' in option).toBe(false);
    expect(await stub.tryAnalyze(mp4File())).toBeNull();
    expect(factory).toHaveBeenCalledTimes(3);
  });

  it('passes a ProbeError from another copy of the package through as it is, instead of wrapping it as worker-failed', async () => {
    const foreign = foreignProbeError('engine-not-registered', 'engine mp4box is not registered', 'mp4box');
    expect(foreign).not.toBeInstanceOf(ProbeError);
    const stub = lazyProbeFrom(() => Promise.reject(foreign));
    await expect(stub.load()).rejects.toBe(foreign);
    await expect(stub.analyze(mp4File())).rejects.toBe(foreign);
    expect('reason' in foreign).toBe(false);
  });

  it('wraps an error that is only named ProbeError, with no string code, as worker-failed', async () => {
    for (const named of [Object.assign(new Error('no code'), { name: 'ProbeError' }), Object.assign(new Error('number code'), { name: 'ProbeError', code: 7 })]) {
      const failed = await lazyProbeFrom(() => Promise.reject(named))
        .load()
        .catch((e: unknown) => e);
      expect(failed).toBeInstanceOf(ProbeError);
      expect(failed).toMatchObject({ code: 'worker-failed', reason: 'load', cause: named });
    }
  });

  it('keeps tryAnalyze and prewarm from throwing when a loaded probe throws synchronously', async () => {
    const boom = () => {
      throw new TypeError('probe threw');
    };
    const probe = { ...fakeProbe(), analyze: boom, tryAnalyze: boom, compare: boom, prewarm: boom } as unknown as Probe<EngineId>;
    const stub = lazyProbeFrom(async () => probe);
    await stub.load();
    expect(await stub.tryAnalyze(mp4File())).toBeNull();
    await expect(stub.prewarm()).resolves.toBeUndefined();
    await expect(stub.analyze(mp4File())).rejects.toThrow('probe threw');
    await expect(stub.compare(mp4File())).rejects.toThrow('probe threw');
  });

  it('is the same function from the lazy entry', () => {
    expect(fromLazyEntry).toBe(lazyProbeFrom);
  });
});

describe('lazy entries', () => {
  it('lazyProbe and lazyProbeClient load their probe module only on first use', async () => {
    const stub = lazyProbe();
    const client = lazyProbeClient({ worker: customWorker('own') });
    expect(loads).toEqual({ root: 0, client: 0 });
    expect(FakeWorker.instances).toHaveLength(0);
    expect(await client.analyze(mp4File('a.mp4'))).toEqual(fakeResult('a.mp4'));
    expect(loads).toEqual({ root: 0, client: 1 });
    expect(FakeWorker.instances.map((w) => w.label)).toEqual(['custom']);
    await stub.prewarm();
    expect(loads).toEqual({ root: 1, client: 1 });
    expect(String(FakeWorker.instances[1].label)).toMatch(/\/worker\/own-isobmff\.worker\.ts$/);
    expect(FakeWorker.instances[1].posted).toEqual([{ v: 1, id: 1, type: 'warm', engines: ['own'], containers: ['isobmff'] }]);
    expect(stub.engines).toEqual(['own']);
  });

  it('lists the engines known from the options before the probe loads, as the loaded probe lists them', async () => {
    const root = lazyProbe({ engines: [mainDescriptor('rvfc'), workerDescriptor('mp4box'), mainDescriptor('rvfc')] });
    const client = lazyProbeClient({ worker: customWorker('mediabunny', 'own'), engines: [mainDescriptor('rvfc'), workerDescriptor('mp4box'), workerDescriptor('mediabunny')] });
    const inline = lazyProbeClient({ worker: 'inline', engines: [mainDescriptor('rvfc')] });
    expect([lazyProbe().engines, root.engines, client.engines, inline.engines]).toEqual([['own'], ['own', 'rvfc', 'mp4box'], ['own', 'mediabunny', 'rvfc', 'mp4box'], ['own', 'rvfc']]);
    expect([root.loaded, client.loaded, inline.loaded]).toEqual([false, false, false]);
    for (const stub of [root, client, inline]) {
      const before = stub.engines;
      expect((await stub.load()).engines).toEqual(before);
    }
  });

  it('lazyProbeClient destroyed before its chunk loads spawns no worker and posts no job', async () => {
    const client = lazyProbeClient({ worker: customWorker('own') });
    const pending = client.analyze(mp4File('a.mp4'));
    client.destroy();
    await expect(pending).rejects.toMatchObject({ name: 'ProbeError', code: 'aborted' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(client.loaded).toBe(true);
    expect(FakeWorker.instances).toHaveLength(0);
  });
});
