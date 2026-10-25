import { openAsBlob } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProbeClient } from '../../src/client/probe.ts';
import type { CustomWorker } from '../../src/client/types.ts';
import { analyze as analyzeCore } from '../../src/core/analyze.ts';
import type { FileResult } from '../../src/core/types.ts';
import { FILES_DIR } from '../helpers/fixtures.ts';
import { fakeResult, FakeWorker } from './fake-worker.ts';
import { analyzed, mp4File, webmFile, workerDescriptor } from './probe-helpers.ts';

beforeEach(() => {
  FakeWorker.reset();
  vi.stubGlobal('Worker', FakeWorker);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const spawned = () => FakeWorker.instances.map((w) => [w.label, analyzed(w).map((m) => (m.type === 'analyze' ? `${m.engine} ${m.name}` : null))]);
const untimed = (r: FileResult) => ({ ...r, io: { ...r.io, ms: 0 } });

describe('custom worker byContainer', () => {
  it('runs own on the worker of the container family and everything else on the custom worker', async () => {
    const worker: CustomWorker<'own' | 'mediabunny'> = { create: FakeWorker.as('custom'), engines: ['own', 'mediabunny'], byContainer: { matroska: FakeWorker.as('matroska') } };
    const probe = createProbeClient({ worker });
    expect(await probe.analyze(webmFile('a.webm'))).toEqual(fakeResult('a.webm'));
    expect(await probe.analyze(mp4File('a.mp4'))).toEqual(fakeResult('a.mp4'));
    expect(await probe.analyze(webmFile('b.webm'), { engine: 'mediabunny' })).toEqual(fakeResult('b.webm', 'mediabunny'));
    expect(spawned()).toEqual([
      ['matroska', ['own a.webm']],
      ['custom', ['own a.mp4', 'mediabunny b.webm']],
    ]);
  });

  it('never starts the custom worker for own when both families have a worker', async () => {
    const probe = createProbeClient({ worker: { create: FakeWorker.as('custom'), engines: ['own'], byContainer: { isobmff: FakeWorker.as('isobmff'), matroska: FakeWorker.as('matroska') } } });
    await probe.analyze(mp4File('a.mp4'));
    await probe.analyze(webmFile('a.webm'));
    expect(spawned()).toEqual([
      ['isobmff', ['own a.mp4']],
      ['matroska', ['own a.webm']],
    ]);
  });

  it('prewarms one request per worker, with the union of the containers of the engines that share it', async () => {
    const probe = createProbeClient({ worker: { create: FakeWorker.as('custom'), engines: ['own', 'mediabunny'], byContainer: { matroska: FakeWorker.as('matroska') } } });
    await probe.prewarm({ engines: ['own', 'mediabunny'], containers: ['isobmff', 'matroska'] });
    expect(FakeWorker.instances.map((w) => [w.label, w.posted])).toEqual([
      ['custom', [{ v: 1, id: 1, type: 'warm', engines: ['own', 'mediabunny'], containers: ['isobmff', 'matroska'] }]],
      ['matroska', [{ v: 1, id: 1, type: 'warm', engines: ['own'], containers: ['matroska'] }]],
    ]);
  });

  it('applies to own only, so a custom worker without own ignores it', async () => {
    const probe = createProbeClient({ worker: { create: FakeWorker.as('custom'), engines: ['mediabunny'], byContainer: { matroska: FakeWorker.as('matroska') } }, engines: [workerDescriptor('mp4box')] });
    await probe.analyze(webmFile('a.webm'));
    await probe.analyze(webmFile('b.webm'), { engine: 'mediabunny' });
    expect(spawned()).toEqual([
      ['mp4box', ['own a.webm']],
      ['custom', ['mediabunny b.webm']],
    ]);
  });

  it('is ignored without a Worker global, where own runs in this thread', async () => {
    vi.unstubAllGlobals();
    const created = vi.fn();
    const probe = createProbeClient({ worker: { create: created, engines: ['own'], byContainer: { matroska: created } } });
    const blob = await openAsBlob(join(FILES_DIR, 'cfr_vp9_30.webm'));
    expect(untimed(await probe.analyze(blob, { name: 'a.webm' }))).toEqual(untimed(await analyzeCore(blob, 'a.webm')));
    expect(created).not.toHaveBeenCalled();
  });
});
