import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProbeError } from '../../src/api/errors.ts';
import { createProbeClient } from '../../src/client/probe.ts';
import { fakeResult, FakeWorker } from './fake-worker.ts';
import { analyzed, customWorker, mainDescriptor, mp4File, webmFile, workerDescriptor } from './probe-helpers.ts';

beforeEach(() => {
  FakeWorker.reset();
  vi.stubGlobal('Worker', FakeWorker);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('createProbeClient', () => {
  it('analyzes on the custom worker with the file name, the engine and only the wire options', async () => {
    const probe = createProbeClient({ worker: customWorker('own', 'mp4box'), defaults: { matroskaMode: 'probe', exactBudgetMs: 50 } });
    const progress = vi.fn();
    const result = await probe.analyze(mp4File('clip.mp4'), { matroskaMode: 'exact', onProgress: progress, signal: new AbortController().signal, timeoutMs: 1000, host: {} as HTMLElement });
    expect(result).toEqual(fakeResult('clip.mp4', 'own'));
    expect(result).not.toHaveProperty('attempts');
    expect(FakeWorker.instances.map((w) => w.label)).toEqual(['custom']);
    const [request] = analyzed(FakeWorker.instances[0]);
    expect(request).toEqual({ v: 1, id: request.id, type: 'analyze', file: expect.any(Blob), name: 'clip.mp4', engine: 'own', options: { matroskaMode: 'exact', exactBudgetMs: 50 } });
    await probe.analyze(new Blob([new Uint8Array(8)]), { engine: 'mp4box', name: 'renamed.mov' });
    expect(analyzed(FakeWorker.instances[0])[1]).toMatchObject({ name: 'renamed.mov', engine: 'mp4box', options: { matroskaMode: 'probe', exactBudgetMs: 50 } });
    await probe.analyze(new Blob([new Uint8Array(8)]));
    expect(analyzed(FakeWorker.instances[0])[2]).toMatchObject({ name: '' });
  });

  it('lists own first, then the custom worker engines, then the descriptors', () => {
    const probe = createProbeClient({ worker: customWorker('mediabunny', 'own'), engines: [mainDescriptor('rvfc'), workerDescriptor('mp4box')] });
    expect(probe.engines).toEqual(['own', 'mediabunny', 'rvfc', 'mp4box']);
  });

  it('throws engine-not-registered when own has no route', () => {
    expect(() => createProbeClient({ worker: customWorker('mp4box') })).toThrow(ProbeError);
    expect(() => createProbeClient({ worker: customWorker('mp4box') })).toThrow(expect.objectContaining({ code: 'engine-not-registered', engine: 'own' }));
    expect(() => createProbeClient({ worker: customWorker('mp4box'), engines: [mainDescriptor('rvfc')] })).toThrow(expect.objectContaining({ code: 'engine-not-registered' }));
    expect(createProbeClient({ worker: customWorker('mediabunny'), engines: [workerDescriptor('mp4box')] }).engines).toEqual(['own', 'mediabunny', 'mp4box']);
    expect(createProbeClient({ worker: 'inline', engines: [workerDescriptor('mp4box')] }).engines).toEqual(['own', 'mp4box']);
    expect(() => createProbeClient({ worker: 'inline' })).toThrow(expect.objectContaining({ code: 'engine-not-registered' }));
  });

  it('checks the default engine and fallback at creation and the call engines at call time', async () => {
    expect(() => createProbeClient({ worker: customWorker('own'), engine: 'mp4box' as 'own' })).toThrow(expect.objectContaining({ code: 'engine-not-registered', engine: 'mp4box' }));
    expect(() => createProbeClient({ worker: customWorker('own'), fallback: ['rvfc' as 'own'] })).toThrow(expect.objectContaining({ engine: 'rvfc' }));
    const probe = createProbeClient({ worker: customWorker('own') });
    await expect(probe.analyze(mp4File(), { engine: 'mediabunny' as 'own' })).rejects.toMatchObject({ code: 'engine-not-registered', engine: 'mediabunny' });
    await expect(probe.analyze(mp4File(), { fallback: ['mp4box' as 'own'] })).rejects.toMatchObject({ code: 'engine-not-registered', engine: 'mp4box' });
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it('forwards progress and keeps file problems as data in the result', async () => {
    FakeWorker.reset('reply', (request, worker) => {
      worker.onmessage?.({ data: { v: 1, id: request.id, type: 'progress', progress: { phase: 'moov', done: 1, total: 2 } } });
      return { type: 'result', result: { ...fakeResult('bad.mp4'), error: 'truncated moov' } };
    });
    const probe = createProbeClient({ worker: customWorker('own') });
    const onProgress = vi.fn();
    const result = await probe.analyze(mp4File('bad.mp4'), { onProgress });
    expect(result.error).toBe('truncated moov');
    expect(onProgress).toHaveBeenCalledWith({ phase: 'moov', done: 1, total: 2 });
  });

  it('turns a skipped reply into a result with an error', async () => {
    FakeWorker.reset('reply', () => ({ type: 'skipped', reason: 'unsupported-container' }));
    const probe = createProbeClient({ worker: customWorker('own', 'mp4box') });
    const result = await probe.analyze(webmFile('a.webm'), { engine: 'mp4box' });
    expect(result).toMatchObject({ name: 'a.webm', size: 8, engine: 'mp4box', container: 'unknown', error: 'mp4box does not read this container', videoTracks: [] });
  });

  it('rejects infrastructure problems with ProbeError and tryAnalyze resolves null instead', async () => {
    FakeWorker.reset('reply', () => ({ type: 'error', message: 'Failed to fetch dynamically imported module', aborted: false }));
    const probe = createProbeClient({ worker: customWorker('own') });
    await expect(probe.analyze(mp4File())).rejects.toMatchObject({ name: 'ProbeError', code: 'worker-failed', engine: 'own' });
    expect(await probe.tryAnalyze(mp4File())).toBeNull();
    expect(await probe.tryAnalyze(mp4File(), { engine: 'rvfc' as 'own' })).toBeNull();
    FakeWorker.reset();
    expect(await probe.tryAnalyze(mp4File('ok.mp4'))).toEqual(fakeResult('ok.mp4'));
  });

  it('rejects at once with aborted when the signal aborts', async () => {
    FakeWorker.reset('manual');
    const probe = createProbeClient({ worker: customWorker('own') });
    const controller = new AbortController();
    const pending = probe.analyze(mp4File(), { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'ProbeError', code: 'aborted' });
    const before = new AbortController();
    before.abort();
    await expect(probe.analyze(mp4File(), { signal: before.signal })).rejects.toMatchObject({ code: 'aborted' });
  });

  it('prewarms one warm request per worker kind with the engines on it, own and ISO BMFF by default, and never rejects', async () => {
    const probe = createProbeClient({ worker: customWorker('own', 'mediabunny'), engines: [workerDescriptor('mp4box')] });
    await probe.prewarm();
    expect(FakeWorker.instances.map((w) => [w.label, w.posted])).toEqual([['custom', [{ v: 1, id: 1, type: 'warm', engines: ['own'], containers: ['isobmff'] }]]]);
    await probe.prewarm({ engines: ['own', 'mediabunny', 'mp4box'], containers: ['matroska'] });
    const [custom, mp4box] = FakeWorker.instances;
    expect(custom.posted[1]).toMatchObject({ type: 'warm', engines: ['own', 'mediabunny'], containers: ['matroska'] });
    expect([mp4box.label, mp4box.posted]).toEqual(['mp4box', [{ v: 1, id: 1, type: 'warm', engines: ['mp4box'], containers: ['matroska'] }]]);
    FakeWorker.reset('reply', () => ({ type: 'error', message: 'boom', aborted: false }));
    await expect(probe.prewarm({ engines: ['own', 'rvfc' as 'own'] })).resolves.toBeUndefined();
  });

  it('prewarm loads main-thread engines and calls their warm hook', async () => {
    const module = { containers: 'any' as const, run: vi.fn(), warm: vi.fn(async () => {}) };
    const probe = createProbeClient({ worker: customWorker('own'), engines: [mainDescriptor('rvfc', module)] });
    await probe.prewarm({ engines: ['rvfc'], containers: ['isobmff', 'matroska'] });
    expect(module.warm).toHaveBeenCalledWith(['isobmff', 'matroska']);
    expect(module.run).not.toHaveBeenCalled();
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it('dispose terminates idle workers and the next call respawns; destroy aborts running calls', async () => {
    const probe = createProbeClient({ worker: customWorker('own'), idleTimeoutMs: 0 });
    await probe.analyze(mp4File());
    probe.dispose();
    expect(FakeWorker.instances[0].terminated).toBe(true);
    await probe.analyze(mp4File());
    expect(FakeWorker.instances).toHaveLength(2);
    FakeWorker.reset('manual');
    const module = { containers: 'any' as const, run: () => new Promise<never>(() => {}) };
    const busy = createProbeClient({ worker: customWorker('own'), engines: [mainDescriptor('rvfc', module)] });
    const onWorker = busy.analyze(mp4File());
    const onMain = busy.analyze(mp4File(), { engine: 'rvfc' });
    await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    busy.destroy();
    await expect(onWorker).rejects.toMatchObject({ code: 'aborted' });
    await expect(onMain).rejects.toMatchObject({ code: 'aborted', engine: 'rvfc' });
    expect(FakeWorker.instances[0].terminated).toBe(true);
    FakeWorker.reset();
    expect(await busy.analyze(mp4File('after.mp4'))).toEqual(fakeResult('after.mp4'));
  });

  it('applies the default timeout per attempt and a call timeout over it', async () => {
    vi.useFakeTimers();
    FakeWorker.reset('hang');
    const probe = createProbeClient({ worker: customWorker('own'), timeoutMs: 1000 });
    const byDefault = probe.analyze(mp4File()).catch((e: unknown) => e);
    const byCall = probe.analyze(mp4File(), { timeoutMs: 5000 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await byDefault).toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await byCall).toMatchObject({ code: 'timeout', message: 'timed out after 5000 ms' });
  });
});
