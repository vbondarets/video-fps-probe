import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProbeError } from '../../src/api/errors.ts';
import { fakeResult, FakeWorker } from './fake-worker.ts';
import { analyzed, customWorker, fakeModule, mainDescriptor, mp4File, workerDescriptor } from './probe-helpers.ts';

const loads = vi.hoisted(() => ({ agreement: 0 }));

vi.mock('../../src/api/agreement.ts', async (importOriginal) => {
  loads.agreement++;
  return importOriginal();
});

import { createProbeClient } from '../../src/client/probe.ts';

beforeEach(() => {
  FakeWorker.reset();
  vi.stubGlobal('Worker', FakeWorker);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const posted = () => FakeWorker.instances.map((w) => [w.label, analyzed(w).map((m) => (m.type === 'analyze' ? m.engine : null))]);

describe('probe.compare', () => {
  it('loads the agreement rules only when compare runs', async () => {
    const probe = createProbeClient({ worker: customWorker('own') });
    expect(loads.agreement).toBe(0);
    await probe.analyze(mp4File());
    expect(loads.agreement).toBe(0);
    await probe.compare(mp4File());
    expect(loads.agreement).toBe(1);
  });

  it('runs every registered engine except rVFC and reports ok outcomes with the agreement against own', async () => {
    const rvfc = fakeModule('rvfc');
    const probe = createProbeClient({ worker: customWorker('own', 'mp4box'), engines: [mainDescriptor('rvfc', rvfc)] });
    const r = await probe.compare(mp4File('clip.mp4'));
    expect(Object.keys(r.outcomes)).toEqual(['own', 'mp4box']);
    expect(r.outcomes.own).toEqual({ status: 'ok', result: fakeResult('clip.mp4', 'own'), ms: expect.any(Number) });
    expect(r.outcomes.mp4box).toMatchObject({ status: 'ok', result: { engine: 'mp4box' } });
    expect(rvfc.calls).toHaveLength(0);
    expect(r).toMatchObject({ name: 'clip.mp4', size: 16, reference: 'own', agreement: { reference: 'own', engines: ['own', 'mp4box'], agree: true } });
  });

  it('runs engines on one worker kind one after another and different kinds in parallel, rVFC on the main thread at the same time', async () => {
    FakeWorker.reset('manual');
    let release: (() => void) | null = null;
    const rvfc = { containers: 'any' as const, run: () => new Promise<ReturnType<typeof fakeResult>>((resolve) => (release = () => resolve(fakeResult('a.mp4', 'rvfc')))) };
    const probe = createProbeClient({ worker: customWorker('own', 'mediabunny'), engines: [workerDescriptor('mp4box'), mainDescriptor('rvfc', rvfc)], workers: 2 });
    const pending = probe.compare(mp4File('a.mp4'), { engines: ['own', 'mediabunny', 'mp4box', 'rvfc'] });
    await vi.waitFor(() => expect(posted()).toEqual([['custom', ['own']], ['mp4box', ['mp4box']]]));
    await vi.waitFor(() => expect(release).not.toBeNull());
    const [custom, mp4box] = FakeWorker.instances;
    custom.answer(analyzed(custom)[0].id);
    await vi.waitFor(() => expect(posted()).toEqual([['custom', ['own', 'mediabunny']], ['mp4box', ['mp4box']]]));
    custom.answer(analyzed(custom)[1].id);
    mp4box.answer(analyzed(mp4box)[0].id);
    await vi.waitFor(() => expect(release).not.toBeNull());
    release!();
    const r = await pending;
    expect(Object.values(r.outcomes).map((o) => o?.status)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(r.outcomes.rvfc).toMatchObject({ status: 'ok', result: { engine: 'rvfc' } });
  });

  it('keeps the outcomes in the requested engine order when a later engine finishes first', async () => {
    FakeWorker.reset('manual');
    const probe = createProbeClient({ worker: customWorker('own', 'mp4box'), engines: [mainDescriptor('rvfc')] });
    const pending = probe.compare(mp4File('a.mp4'), { engines: ['mp4box', 'own', 'rvfc'] });
    await vi.waitFor(() => expect(posted()).toEqual([['custom', ['mp4box']]]));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const [custom] = FakeWorker.instances;
    custom.answer(analyzed(custom)[0].id);
    await vi.waitFor(() => expect(posted()).toEqual([['custom', ['mp4box', 'own']]]));
    custom.answer(analyzed(custom)[1].id);
    const r = await pending;
    expect(Object.keys(r.outcomes)).toEqual(['mp4box', 'own', 'rvfc']);
  });

  it('reports failed, skipped, timeout and crashed outcomes per engine without rejecting', async () => {
    vi.useFakeTimers();
    FakeWorker.reset('reply', (m, w) => {
      if (m.type !== 'analyze') return undefined;
      if (m.engine === 'own') return { type: 'result', result: { ...fakeResult(m.name), error: 'moov not found' } };
      if (m.engine === 'mp4box') return { type: 'skipped', reason: 'unsupported-container' };
      if (w.label === 'mediabunny') return 'hang';
      return undefined;
    });
    const environment = { containers: 'any' as const, run: () => Promise.reject(new ProbeError('unsupported-environment', 'needs a DOM', { engine: 'rvfc' })) };
    const probe = createProbeClient({ worker: customWorker('own', 'mp4box'), engines: [workerDescriptor('mediabunny'), mainDescriptor('rvfc', environment)] });
    const pending = probe.compare(mp4File(), { engines: ['own', 'mp4box', 'mediabunny', 'rvfc'], timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    const r = await pending;
    expect(r.outcomes.own).toMatchObject({ status: 'failed', error: 'moov not found', result: { error: 'moov not found' } });
    expect(r.outcomes.mp4box).toEqual({ status: 'skipped', reason: 'unsupported-container' });
    expect(r.outcomes.mediabunny).toMatchObject({ status: 'timeout', error: { name: 'ProbeError', code: 'timeout', engine: 'mediabunny' } });
    expect(r.outcomes.rvfc).toEqual({ status: 'skipped', reason: 'unsupported-environment' });
    expect(r.agreement).toMatchObject({ reference: null, engines: [], agree: null });
    vi.useRealTimers();
    FakeWorker.reset('reply', (m, w) => {
      if (m.type === 'analyze' && m.engine === 'mediabunny') {
        queueMicrotask(() => w.crash('out of memory'));
        return 'hang';
      }
      return undefined;
    });
    const crashed = await probe.compare(mp4File(), { engines: ['own', 'mediabunny'] });
    expect(crashed.outcomes.mediabunny).toMatchObject({ status: 'crashed', error: { code: 'worker-failed', message: 'out of memory', reason: 'crash' } });
    expect(crashed.outcomes.own?.status).toBe('ok');
    FakeWorker.reset('reply', (m) =>
      m.type === 'analyze' && m.engine === 'mediabunny' ? { type: 'error', message: 'Failed to fetch dynamically imported module', aborted: false, reason: 'load' } : undefined,
    );
    const unloaded = await probe.compare(mp4File(), { engines: ['own', 'mediabunny'] });
    expect(unloaded.outcomes.mediabunny).toMatchObject({ status: 'crashed', error: { code: 'worker-failed', engine: 'mediabunny', reason: 'load' } });
  });

  it('compares against the requested reference and lists the engines that differ', async () => {
    FakeWorker.reset('reply', (m) => (m.type === 'analyze' && m.engine === 'mp4box' ? { type: 'result', result: fakeResult(m.name, 'mp4box', 25) } : undefined));
    const probe = createProbeClient({ worker: customWorker('own', 'mp4box', 'mediabunny') });
    const r = await probe.compare(mp4File(), { reference: 'mp4box' });
    expect(r.reference).toBe('mp4box');
    expect(r.agreement.agree).toBe(false);
    expect(r.agreement.fields.find((f) => f.field === 'avgFps')).toMatchObject({ agree: false, differ: ['own', 'mediabunny'] });
  });

  it('tags progress with the engine, rejects on abort and on an engine that is not registered', async () => {
    FakeWorker.reset('reply', (m, w) => {
      w.onmessage?.({ data: { v: 1, id: m.id, type: 'progress', progress: { phase: 'scan', done: 1, total: 1 } } });
      return undefined;
    });
    const probe = createProbeClient({ worker: customWorker('own', 'mp4box') });
    const onProgress = vi.fn();
    await probe.compare(mp4File(), { onProgress });
    expect(onProgress.mock.calls.map(([p]) => p.engine).sort()).toEqual(['mp4box', 'own']);
    expect(onProgress).toHaveBeenCalledWith({ phase: 'scan', done: 1, total: 1, engine: 'own' });
    FakeWorker.reset('manual');
    const stuck = createProbeClient({ worker: customWorker('own', 'mp4box') });
    const controller = new AbortController();
    const pending = stuck.compare(mp4File(), { signal: controller.signal });
    await vi.waitFor(() => expect(FakeWorker.instances.length).toBeGreaterThan(0));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'ProbeError', code: 'aborted' });
    await expect(probe.compare(mp4File(), { engines: ['rvfc' as 'own'] })).rejects.toMatchObject({ code: 'engine-not-registered', engine: 'rvfc' });
  });
});
