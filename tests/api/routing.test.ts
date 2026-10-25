import { openAsBlob } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProbeClient } from '../../src/client/create.ts';
import { createProbeCore } from '../../src/client/probe.ts';
import { analyze as analyzeCore } from '../../src/core/analyze.ts';
import type { FileResult } from '../../src/core/types.ts';
import { FILES_DIR } from '../helpers/fixtures.ts';
import { fakeResult, FakeWorker } from './fake-worker.ts';
import { analyzed, customWorker, fakeModule, mainDescriptor, mp4File, workerDescriptor } from './probe-helpers.ts';

beforeEach(() => {
  FakeWorker.reset();
  vi.stubGlobal('Worker', FakeWorker);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const MP4 = join(FILES_DIR, 'cfr_h264_30.mp4');
const WEBM = join(FILES_DIR, 'cfr_vp9_30.webm');

const untimed = (r: FileResult) => ({ ...r, io: { ...r.io, ms: 0 } });

const spawned = () => FakeWorker.instances.map((w) => [w.label, analyzed(w).map((m) => (m.type === 'analyze' ? m.engine : null))]);

describe('engine routing', () => {
  it('runs own on the custom worker when it lists own, even with prebuilt descriptors', async () => {
    const probe = createProbeClient({ worker: customWorker('own'), engines: [workerDescriptor('mp4box')] });
    await probe.analyze(mp4File());
    await probe.analyze(mp4File(), { engine: 'mp4box' });
    expect(spawned()).toEqual([
      ['custom', ['own']],
      ['mp4box', ['mp4box']],
    ]);
  });

  it('runs own on the default engine worker, so an mp4box probe with an own fallback spawns one worker', async () => {
    FakeWorker.reset('reply', (m) => (m.type === 'analyze' && m.engine === 'mp4box' ? { type: 'result', result: { ...fakeResult(m.name, 'mp4box'), error: 'bad' } } : undefined));
    const probe = createProbeClient({ worker: customWorker('mediabunny'), engines: [workerDescriptor('mediabunny'), workerDescriptor('mp4box')], engine: 'mp4box', fallback: ['own'] });
    const result = await probe.analyze(mp4File());
    expect(result.engine).toBe('own');
    expect(spawned()).toEqual([['mp4box', ['mp4box', 'own']]]);
  });

  it('runs own on the own descriptor worker before any other prebuilt worker', async () => {
    const probe = createProbeCore({ engines: [workerDescriptor('own', fakeModule('own'), null), workerDescriptor('mp4box')] });
    await probe.analyze(mp4File());
    expect(spawned()).toEqual([['own', ['own']]]);
  });

  it('runs own on the first prebuilt worker that serves it when nothing else does', async () => {
    const probe = createProbeClient({ worker: customWorker('mp4box'), engines: [mainDescriptor('rvfc'), workerDescriptor('mediabunny')] });
    await probe.analyze(mp4File());
    expect(spawned()).toEqual([['mediabunny', ['own']]]);
  });

  it('shares one pool per worker kind and spawns separate kinds separately', async () => {
    const probe = createProbeClient({ worker: customWorker('own', 'mediabunny'), engines: [workerDescriptor('mp4box')], workers: 2 });
    await Promise.all([probe.analyze(mp4File()), probe.analyze(mp4File(), { engine: 'mediabunny' }), probe.analyze(mp4File(), { engine: 'mp4box' })]);
    expect(FakeWorker.instances.map((w) => w.label).sort()).toEqual(['custom', 'custom', 'mp4box']);
  });

  it('runs main-thread engines in this thread with the call host', async () => {
    const rvfc = fakeModule('rvfc');
    const probe = createProbeClient({ worker: customWorker('own'), engines: [mainDescriptor('rvfc', rvfc)] });
    const host = { id: 'host' } as unknown as HTMLElement;
    const result = await probe.analyze(mp4File('a.mp4'), { engine: 'rvfc', host, matroskaMode: 'exact' });
    expect(result).toEqual(fakeResult('a.mp4', 'rvfc'));
    expect(rvfc.calls).toEqual([{ name: 'a.mp4', opts: expect.objectContaining({ host, matroskaMode: 'exact', signal: expect.any(AbortSignal) }) }]);
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it('with worker inline runs prebuilt descriptors and own in this thread', async () => {
    const mp4box = fakeModule('mp4box');
    const own = fakeModule('own');
    const probe = createProbeClient({ worker: 'inline', engines: [workerDescriptor('mp4box', mp4box, own)] });
    expect((await probe.analyze(mp4File('a.mp4'))).engine).toBe('own');
    expect((await probe.analyze(mp4File('b.mp4'), { engine: 'mp4box' })).engine).toBe('mp4box');
    expect([own.calls.map((c) => c.name), mp4box.calls.map((c) => c.name)]).toEqual([['a.mp4'], ['b.mp4']]);
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it('with worker inline and no prebuilt engine runs own in this thread exactly as the core does', async () => {
    const probe = createProbeClient({ worker: 'inline' });
    expect(probe.engines).toEqual(['own']);
    for (const [file, name] of [
      [MP4, 'a.mp4'],
      [WEBM, 'a.webm'],
    ]) {
      const blob = await openAsBlob(file);
      expect(untimed(await probe.analyze(blob, { name }))).toEqual(untimed(await analyzeCore(blob, name)));
    }
    await expect(probe.prewarm({ containers: ['isobmff', 'matroska'] })).resolves.toBeUndefined();
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it('without a Worker global runs own in this thread and rejects the other custom worker engines with unsupported-environment', async () => {
    vi.unstubAllGlobals();
    expect(typeof Worker).toBe('undefined');
    const created = vi.fn();
    const own = fakeModule('own');
    const ssr = createProbeClient({ worker: { create: created, engines: ['own', 'mediabunny'] } });
    expect(ssr.engines).toEqual(['own', 'mediabunny']);
    const blob = await openAsBlob(MP4);
    expect(untimed(await ssr.analyze(blob, { name: 'a.mp4' }))).toEqual(untimed(await analyzeCore(blob, 'a.mp4')));
    await expect(ssr.analyze(mp4File(), { engine: 'mediabunny' })).rejects.toMatchObject({ name: 'ProbeError', code: 'unsupported-environment', engine: 'mediabunny' });
    expect(await ssr.tryAnalyze(mp4File(), { engine: 'mediabunny' })).toBeNull();
    const withPrebuilt = createProbeClient({ worker: { create: created, engines: ['own', 'mediabunny'] }, engines: [workerDescriptor('mp4box', fakeModule('mp4box'), own)] });
    expect((await withPrebuilt.analyze(mp4File('a.mp4'))).engine).toBe('own');
    expect(own.calls).toHaveLength(1);
    await expect(withPrebuilt.analyze(mp4File(), { engine: 'mediabunny' })).rejects.toMatchObject({ code: 'unsupported-environment', engine: 'mediabunny' });
    expect(created).not.toHaveBeenCalled();
  });
});
