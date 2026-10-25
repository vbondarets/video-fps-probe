import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProbeError } from '../../src/api/errors.ts';
import { createProbeClient } from '../../src/client/create.ts';
import { fakeResult, FakeWorker } from './fake-worker.ts';
import { analyzed, customWorker, fakeModule, mainDescriptor, mp4File, webmFile, workerDescriptor } from './probe-helpers.ts';

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
    expect(createProbeClient({ worker: 'inline' }).engines).toEqual(['own']);
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

  it('turns a skipped reply into a result with the sniffed container and an error', async () => {
    FakeWorker.reset('reply', (m) => ({ type: 'skipped', reason: 'unsupported-container', family: m.type === 'analyze' && m.name === 'a.webm' ? 'matroska' : null }));
    const probe = createProbeClient({ worker: customWorker('own', 'mp4box') });
    const result = await probe.analyze(webmFile('a.webm'), { engine: 'mp4box' });
    expect(result).toMatchObject({ name: 'a.webm', size: 8, engine: 'mp4box', container: 'matroska', error: 'unsupported by mp4box', videoTracks: [] });
    const unknown = await probe.analyze(new File([new Uint8Array(8)], 'zeros.bin'), { engine: 'mp4box' });
    expect(unknown).toMatchObject({ name: 'zeros.bin', engine: 'mp4box', container: 'unknown', error: 'not a recognised container' });
  });

  it('rejects infrastructure problems with ProbeError and tryAnalyze resolves null instead', async () => {
    FakeWorker.reset('reply', () => ({ type: 'error', message: 'Failed to fetch dynamically imported module', aborted: false }));
    const probe = createProbeClient({ worker: customWorker('own') });
    await expect(probe.analyze(mp4File())).rejects.toMatchObject({ name: 'ProbeError', code: 'worker-failed', engine: 'own', reason: 'crash' });
    expect(await probe.tryAnalyze(mp4File())).toBeNull();
    expect(await probe.tryAnalyze(mp4File(), { engine: 'rvfc' as 'own' })).toBeNull();
    FakeWorker.reset();
    expect(await probe.tryAnalyze(mp4File('ok.mp4'))).toEqual(fakeResult('ok.mp4'));
  });

  it('rejects with the load reason when the worker script fails to load, tryAnalyze resolves null, and the next call starts a new worker', async () => {
    FakeWorker.reset('manual');
    const probe = createProbeClient({ worker: customWorker('own') });
    const first = probe.analyze(mp4File('a.mp4'));
    const second = probe.tryAnalyze(mp4File('b.mp4'));
    await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1));
    FakeWorker.instances[0].failToLoad();
    await expect(first).rejects.toMatchObject({ name: 'ProbeError', code: 'worker-failed', engine: 'own', reason: 'load' });
    expect(await second).toBeNull();
    expect(FakeWorker.instances).toHaveLength(1);
    FakeWorker.reset();
    expect(await probe.analyze(mp4File('c.mp4'))).toEqual(fakeResult('c.mp4'));
    expect(FakeWorker.instances).toHaveLength(1);
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

  it('applies the default timeout to warm requests, so a stalled warm frees its worker for the next call', async () => {
    vi.useFakeTimers();
    FakeWorker.reset('reply', (m) => (m.type === 'warm' ? 'hang' : undefined));
    const probe = createProbeClient({ worker: customWorker('own'), timeoutMs: 1000 });
    const warmed = probe.prewarm();
    const analyzedFile = probe.analyze(mp4File('a.mp4'));
    await vi.advanceTimersByTimeAsync(1000);
    await expect(warmed).resolves.toBeUndefined();
    expect(await analyzedFile).toEqual(fakeResult('a.mp4'));
    expect(FakeWorker.instances.map((w) => w.terminated)).toEqual([true, false]);
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
    await expect(busy.analyze(mp4File('after.mp4'))).rejects.toMatchObject({ name: 'ProbeError', code: 'aborted' });
    expect(FakeWorker.instances).toHaveLength(0);
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

describe('destroy', () => {
  const aborted = { name: 'ProbeError', code: 'aborted' };

  it('aborts a fallback call that waits for the fallback chunk, and no worker runs it', async () => {
    const probe = createProbeClient({ worker: customWorker('own', 'mp4box') });
    const pending = probe.analyze(mp4File(), { fallback: ['mp4box'] });
    probe.destroy();
    await expect(pending).rejects.toMatchObject(aborted);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it('aborts a skipped call that waits for the fallback chunk instead of resolving with the skipped result', async () => {
    FakeWorker.reset('manual');
    const probe = createProbeClient({ worker: customWorker('own', 'mp4box') });
    const pending = probe.analyze(webmFile(), { engine: 'mp4box' });
    const [worker] = FakeWorker.instances;
    const [request] = analyzed(worker);
    worker.answer(request.id, { type: 'skipped', reason: 'unsupported-container', family: 'matroska' });
    probe.destroy();
    await expect(pending).rejects.toMatchObject(aborted);
  });

  it('aborts a compare that waits for the compare chunk, and no worker runs it', async () => {
    const module = fakeModule('rvfc');
    const probe = createProbeClient({ worker: customWorker('own', 'mp4box'), engines: [mainDescriptor('rvfc', module)] });
    const pending = probe.compare(mp4File(), { engines: ['own', 'mp4box', 'rvfc'] });
    probe.destroy();
    await expect(pending).rejects.toMatchObject(aborted);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(FakeWorker.instances).toHaveLength(0);
    expect(module.calls).toEqual([]);
  });

  it('aborts running and queued pool jobs and the engines a compare has not reached yet, without respawning', async () => {
    FakeWorker.reset('manual');
    const probe = createProbeClient({ worker: customWorker('own', 'mp4box'), workers: 1 });
    const jobs = [probe.analyze(mp4File('a.mp4')), probe.analyze(mp4File('b.mp4')), probe.analyze(mp4File('c.mp4'), { fallback: ['mp4box'] })];
    const compared = probe.compare(mp4File('d.mp4'), { engines: ['own', 'mp4box'] });
    await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    probe.destroy();
    for (const job of [...jobs, compared]) await expect(job).rejects.toMatchObject(aborted);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0].terminated).toBe(true);
    expect(analyzed(FakeWorker.instances[0]).map((r) => r.name)).toEqual(['a.mp4']);
  });

  it('rejects every call made after it on worker and main-thread routes, and prewarm spawns nothing', async () => {
    const module = fakeModule('rvfc');
    const probe = createProbeClient({ worker: customWorker('own', 'mp4box'), engines: [mainDescriptor('rvfc', module)] });
    probe.destroy();
    await expect(probe.analyze(mp4File())).rejects.toMatchObject({ ...aborted, engine: 'own' });
    await expect(probe.analyze(mp4File(), { engine: 'rvfc' })).rejects.toMatchObject({ ...aborted, engine: 'rvfc' });
    await expect(probe.analyze(mp4File(), { fallback: ['mp4box'] })).rejects.toMatchObject(aborted);
    await expect(probe.compare(mp4File())).rejects.toMatchObject(aborted);
    expect(await probe.tryAnalyze(mp4File())).toBeNull();
    await expect(probe.prewarm({ engines: ['own', 'mp4box', 'rvfc'] })).resolves.toBeUndefined();
    expect(FakeWorker.instances).toHaveLength(0);
    expect(module.calls).toEqual([]);
  });
});
