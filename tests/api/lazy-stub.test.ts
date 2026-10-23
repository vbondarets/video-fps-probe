import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineId } from '../../src/core/types.ts';
import type { Probe } from '../../src/client/types.ts';
import { fakeResult, FakeWorker } from './fake-worker.ts';
import { customWorker, mp4File } from './probe-helpers.ts';

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
    stub.destroy();
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
    await expect(stub.analyze(mp4File())).rejects.toThrow('Failed to fetch dynamically imported module');
    expect(stub.loaded).toBe(false);
    expect(await stub.tryAnalyze(mp4File())).toBeNull();
    await expect(stub.prewarm()).resolves.toBeUndefined();
    expect((await stub.analyze(mp4File('d.mp4'))).name).toBe('d.mp4');
    expect(factory).toHaveBeenCalledTimes(4);
    expect(stub.loaded).toBe(true);
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
    expect(String(FakeWorker.instances[1].label)).toMatch(/\/worker\/own\.worker\.ts$/);
    expect(FakeWorker.instances[1].posted).toEqual([{ v: 1, id: 1, type: 'warm', engines: ['own'], containers: ['isobmff'] }]);
    expect(stub.engines).toEqual(['own']);
  });
});
