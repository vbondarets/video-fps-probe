import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeResult, FakeWorker } from './fake-worker.ts';
import { analyzed, mp4File, webmFile } from './probe-helpers.ts';

const loads = vi.hoisted(() => ({ route: 0 }));

vi.mock('../../src/client/route.ts', async (importOriginal) => {
  loads.route++;
  return importOriginal();
});

import { lazyProbeClient } from '../../src/client/lazy.ts';

beforeEach(() => {
  FakeWorker.reset();
  vi.stubGlobal('Worker', FakeWorker);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const spawned = () => FakeWorker.instances.map((w) => [w.label, analyzed(w).map((m) => (m.type === 'analyze' ? `${m.engine} ${m.name}` : null))]);

describe('lazyProbeClient and the split routing', () => {
  it('never loads the split routing for a custom worker without byContainer', async () => {
    const probe = lazyProbeClient({ worker: { create: FakeWorker.as('custom'), engines: ['own'] } });
    expect(await probe.analyze(webmFile('a.webm'))).toEqual(fakeResult('a.webm'));
    expect(await probe.analyze(mp4File('a.mp4'))).toEqual(fakeResult('a.mp4'));
    await probe.prewarm({ containers: ['isobmff', 'matroska'] });
    expect(spawned()).toEqual([['custom', ['own a.webm', 'own a.mp4']]]);
    expect(FakeWorker.instances[0]!.posted.at(-1)).toEqual({ v: 1, id: 3, type: 'warm', engines: ['own'], containers: ['isobmff', 'matroska'] });
    expect(loads.route).toBe(0);
  });

  it('loads it once with byContainer and runs own on the worker of the container family', async () => {
    const probe = lazyProbeClient({ worker: { create: FakeWorker.as('custom'), engines: ['own'], byContainer: { matroska: FakeWorker.as('matroska') } } });
    expect(loads.route).toBe(0);
    expect(await probe.analyze(webmFile('b.webm'))).toEqual(fakeResult('b.webm'));
    expect(await probe.analyze(mp4File('b.mp4'))).toEqual(fakeResult('b.mp4'));
    await probe.analyze(webmFile('c.webm'));
    expect(spawned()).toEqual([
      ['matroska', ['own b.webm', 'own c.webm']],
      ['custom', ['own b.mp4']],
    ]);
    expect(loads.route).toBe(1);
  });
});
