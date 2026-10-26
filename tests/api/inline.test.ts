import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProbeError } from '../../src/api/errors.ts';
import { runInline } from '../../src/client/inline.ts';
import type { EngineModule } from '../../src/plugins/types.ts';
import { fakeResult } from './fake-worker.ts';
import { fakeModule, foreignProbeError, mp4File, webmFile } from './probe-helpers.ts';

afterEach(() => {
  vi.useRealTimers();
});

const hanging = (seen: AbortSignal[] = []): EngineModule => ({
  containers: 'any',
  run: (_blob, _name, opts) => {
    if (opts.signal) seen.push(opts.signal);
    return new Promise(() => {});
  },
});

describe('runInline', () => {
  it('runs the engine module with the name, the wire options, the host and progress', async () => {
    const module = fakeModule('mp4box');
    const onProgress = vi.fn();
    const host = {} as HTMLElement;
    const reply = await runInline(async () => module, mp4File(), 'named.mp4', { matroskaMode: 'probe' }, { engine: 'mp4box', signals: [], onProgress, host });
    expect(reply).toEqual({ type: 'result', result: fakeResult('named.mp4', 'mp4box') });
    expect(module.calls).toEqual([{ name: 'named.mp4', opts: { matroskaMode: 'probe', signal: expect.any(AbortSignal), onProgress, host } }]);
  });

  it('skips a container the engine does not read without running it', async () => {
    const module = fakeModule('mp4box', undefined, ['isobmff']);
    expect(await runInline(async () => module, webmFile(), 'a.webm', {}, { engine: 'mp4box', signals: [] })).toEqual({ type: 'skipped', reason: 'unsupported-container', family: 'matroska' });
    expect(await runInline(async () => module, new Blob([new Uint8Array(32)]), 'zeros', {}, { engine: 'mp4box', signals: [] })).toEqual({ type: 'skipped', reason: 'unsupported-container', family: null });
    expect((await runInline(async () => module, mp4File(), 'a.mp4', {}, { engine: 'mp4box', signals: [] })).type).toBe('result');
    expect(module.calls.map((c) => c.name)).toEqual(['a.mp4']);
  });

  it('times out with ProbeError timeout and aborts the engine signal', async () => {
    vi.useFakeTimers();
    const seen: AbortSignal[] = [];
    const pending = runInline(async () => hanging(seen), mp4File(), 'a.mp4', {}, { engine: 'own', signals: [], timeoutMs: 300 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(300);
    const error = await pending;
    expect(error).toBeInstanceOf(ProbeError);
    expect(error).toMatchObject({ code: 'timeout', engine: 'own', message: 'timed out after 300 ms' });
    expect(seen[0].aborted).toBe(true);
  });

  it('rejects at once on either signal and aborts the engine signal; an aborted signal never loads the engine', async () => {
    const seen: AbortSignal[] = [];
    const call = new AbortController();
    const life = new AbortController();
    const first = runInline(async () => hanging(seen), mp4File(), 'a.mp4', {}, { engine: 'own', signals: [call.signal, life.signal] });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    call.abort(new Error('user cancelled'));
    await expect(first).rejects.toMatchObject({ code: 'aborted', cause: expect.objectContaining({ message: 'user cancelled' }) });
    expect(seen[0].aborted).toBe(true);
    const second = runInline(async () => hanging(seen), mp4File(), 'b.mp4', {}, { engine: 'own', signals: [undefined, life.signal] });
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    life.abort();
    await expect(second).rejects.toMatchObject({ code: 'aborted' });
    const load = vi.fn(async () => hanging());
    await expect(runInline(load, mp4File(), 'c.mp4', {}, { engine: 'own', signals: [call.signal] })).rejects.toMatchObject({ code: 'aborted' });
    expect(load).not.toHaveBeenCalled();
  });

  it('maps an engine exception to worker-failed and passes a ProbeError through', async () => {
    const throwing = (e: unknown): EngineModule => ({ containers: 'any', run: async () => Promise.reject(e) });
    await expect(runInline(async () => throwing(new TypeError('boom')), mp4File(), 'a.mp4', {}, { engine: 'rvfc', signals: [] })).rejects.toMatchObject({ name: 'ProbeError', code: 'worker-failed', engine: 'rvfc', message: 'boom', reason: 'crash' });
    const environment = new ProbeError('unsupported-environment', 'needs a DOM', { engine: 'rvfc' });
    await expect(runInline(async () => throwing(environment), mp4File(), 'a.mp4', {}, { engine: 'rvfc', signals: [] })).rejects.toBe(environment);
    await expect(runInline(() => Promise.reject(new Error('chunk failed')), mp4File(), 'a.mp4', {}, { engine: 'mp4box', signals: [] })).rejects.toMatchObject({ code: 'worker-failed', message: 'chunk failed', reason: 'load' });
    const foreign = foreignProbeError('unsupported-environment', 'needs a DOM', 'rvfc');
    await expect(runInline(async () => throwing(foreign), mp4File(), 'a.mp4', {}, { engine: 'rvfc', signals: [] })).rejects.toBe(foreign);
  });

  it('reports a module that fails to load as a load failure and an engine that throws after it loaded as a crash', async () => {
    const chunk = new TypeError('Failed to fetch dynamically imported module: https://example.test/assets/rvfc-old.js');
    const loadFailure = (await runInline(() => Promise.reject(chunk), mp4File(), 'a.mp4', {}, { engine: 'rvfc', signals: [] }).catch((e: unknown) => e)) as ProbeError;
    expect(loadFailure).toMatchObject({ name: 'ProbeError', code: 'worker-failed', engine: 'rvfc', reason: 'load', message: chunk.message });
    expect(loadFailure.cause).toBe(chunk);
    const sniffing: EngineModule = { containers: ['isobmff'], run: async () => Promise.reject(new RangeError('bad sample table')) };
    await expect(runInline(async () => sniffing, mp4File(), 'a.mp4', {}, { engine: 'mp4box', signals: [] })).rejects.toMatchObject({ code: 'worker-failed', reason: 'crash', message: 'bad sample table' });
  });
});
