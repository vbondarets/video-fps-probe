import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loads = vi.hoisted(() => ({ fallback: 0 }));

vi.mock('../../src/client/fallback.ts', async (importOriginal) => {
  loads.fallback++;
  return importOriginal();
});

import { createProbeClient } from '../../src/client/probe.ts';
import { fakeResult, FakeWorker } from './fake-worker.ts';
import { analyzed, customWorker, fakeModule, mainDescriptor, mp4File } from './probe-helpers.ts';

beforeEach(() => {
  vi.stubGlobal('Worker', FakeWorker);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const engines = (w: FakeWorker) => analyzed(w).map((m) => (m.type === 'analyze' ? m.engine : null));

describe('fallback chain', () => {
  it('returns a single engine result as it is, error included, and loads the chain module only for a chain or a skip', async () => {
    FakeWorker.reset('reply', (m) => (m.type === 'analyze' && m.name === 'bad.mp4' ? { type: 'result', result: { ...fakeResult(m.name), error: 'moov not found' } } : undefined));
    const probe = createProbeClient({ worker: customWorker('own', 'mp4box') });
    expect(await probe.analyze(mp4File('a.mp4'))).toEqual(fakeResult('a.mp4'));
    expect(await probe.analyze(mp4File('bad.mp4'))).toEqual({ ...fakeResult('bad.mp4'), error: 'moov not found' });
    expect(loads.fallback).toBe(0);
    const [worker] = FakeWorker.instances;
    FakeWorker.reset('reply', () => ({ type: 'skipped', reason: 'unsupported-container' }));
    expect(await probe.analyze(mp4File('c.webm'), { engine: 'mp4box' })).toMatchObject({ engine: 'mp4box', error: 'mp4box does not read this container' });
    expect(analyzed(worker)).toHaveLength(3);
    expect(loads.fallback).toBe(1);
  });

  it('moves to the next engine on an error result and records the attempt', async () => {
    FakeWorker.reset('reply', (m) => (m.type === 'analyze' && m.engine === 'own' ? { type: 'result', result: { ...fakeResult(m.name), error: 'moov not found' } } : undefined));
    const probe = createProbeClient({ worker: customWorker('own', 'mp4box'), fallback: ['mp4box'] });
    const result = await probe.analyze(mp4File('a.mp4'));
    expect(result).toEqual({ ...fakeResult('a.mp4', 'mp4box'), attempts: [{ engine: 'own', error: 'moov not found' }] });
    expect(engines(FakeWorker.instances[0])).toEqual(['own', 'mp4box']);
  });

  it('moves on when the result has no video track or no primary frame rate', async () => {
    FakeWorker.reset('reply', (m) => {
      if (m.type !== 'analyze') return undefined;
      if (m.engine === 'own') return { type: 'result', result: { ...fakeResult(m.name), videoTracks: [], primaryTrackId: null } };
      if (m.engine === 'mp4box') return { type: 'result', result: fakeResult(m.name, 'mp4box', null) };
      return undefined;
    });
    const probe = createProbeClient({ worker: customWorker('own', 'mp4box', 'mediabunny'), fallback: ['mp4box', 'mediabunny'] });
    const result = await probe.analyze(mp4File('a.mp4'));
    expect(result.engine).toBe('mediabunny');
    expect(result.attempts).toEqual([
      { engine: 'own', error: 'no video track' },
      { engine: 'mp4box', error: 'no frame rate' },
    ]);
  });

  it('moves on after a timeout or a crash', async () => {
    vi.useFakeTimers();
    FakeWorker.reset('reply', (m) => (m.type === 'analyze' && m.engine === 'own' ? 'hang' : undefined));
    const probe = createProbeClient({ worker: customWorker('own', 'mp4box'), fallback: ['mp4box'], timeoutMs: 500 });
    const timedOut = probe.analyze(mp4File('a.mp4'));
    await vi.advanceTimersByTimeAsync(500);
    expect(await timedOut).toMatchObject({ engine: 'mp4box', attempts: [{ engine: 'own', error: 'timed out after 500 ms' }] });
    vi.useRealTimers();
    FakeWorker.reset('reply', (m, w) => {
      if (m.type === 'analyze' && m.engine === 'own') {
        queueMicrotask(() => w.crash('out of memory'));
        return 'hang';
      }
      return undefined;
    });
    const crashed = await probe.analyze(mp4File('b.mp4'));
    expect(crashed).toMatchObject({ engine: 'mp4box', attempts: [{ engine: 'own', error: 'out of memory' }] });
  });

  it('returns the last result with the other attempts when every engine fails', async () => {
    FakeWorker.reset('reply', (m) => {
      if (m.type !== 'analyze') return undefined;
      if (m.engine === 'own') return { type: 'result', result: { ...fakeResult(m.name), error: 'own failed' } };
      if (m.engine === 'mp4box') return { type: 'result', result: { ...fakeResult(m.name, 'mp4box'), error: 'mp4box failed' } };
      return { type: 'error', message: 'mediabunny crashed', aborted: false };
    });
    const probe = createProbeClient({ worker: customWorker('own', 'mp4box', 'mediabunny') });
    const result = await probe.analyze(mp4File('a.mp4'), { fallback: ['mp4box', 'mediabunny'] });
    expect(result.engine).toBe('mp4box');
    expect(result.error).toBe('mp4box failed');
    expect(result.attempts).toEqual([
      { engine: 'own', error: 'own failed' },
      { engine: 'mediabunny', error: 'mediabunny crashed' },
    ]);
  });

  it('rejects with the last infrastructure error when no engine produced a result', async () => {
    FakeWorker.reset('reply', (m) => ({ type: 'error', message: `${m.type === 'analyze' ? m.engine : ''} unavailable`, aborted: false }));
    const probe = createProbeClient({ worker: customWorker('own', 'mp4box'), fallback: ['mp4box'] });
    await expect(probe.analyze(mp4File())).rejects.toMatchObject({ name: 'ProbeError', code: 'worker-failed', engine: 'mp4box', message: 'mp4box unavailable' });
  });

  it('stops the chain at once on abort', async () => {
    FakeWorker.reset('manual');
    const probe = createProbeClient({ worker: customWorker('own', 'mp4box'), fallback: ['mp4box'] });
    const controller = new AbortController();
    const pending = probe.analyze(mp4File(), { signal: controller.signal });
    await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(engines(FakeWorker.instances[0])).toEqual(['own']);
  });

  it('never adds rVFC implicitly, runs a call chain once per engine, and lets a call override the chain', async () => {
    FakeWorker.reset('reply', (m) => (m.type === 'analyze' ? { type: 'result', result: { ...fakeResult(m.name, m.engine), error: 'bad' } } : undefined));
    const rvfc = fakeModule('rvfc');
    const probe = createProbeClient({ worker: customWorker('own', 'mp4box'), engines: [mainDescriptor('rvfc', rvfc)], fallback: ['mp4box'] });
    const result = await probe.analyze(mp4File());
    expect(result.attempts?.map((a) => a.engine)).toEqual(['own']);
    expect(rvfc.calls).toHaveLength(0);
    await probe.analyze(mp4File(), { engine: 'mp4box', fallback: ['own', 'mp4box', 'own'] });
    expect(engines(FakeWorker.instances[0])).toEqual(['own', 'mp4box', 'mp4box', 'own']);
    const viaRvfc = await probe.analyze(mp4File(), { fallback: ['rvfc'] });
    expect(viaRvfc.engine).toBe('rvfc');
    expect(rvfc.calls).toHaveLength(1);
  });
});
