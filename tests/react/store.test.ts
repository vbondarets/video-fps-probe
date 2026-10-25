import { describe, expect, it } from 'vitest';
import { ProbeError } from '../../src/api/errors.ts';
import { summarize } from '../../src/api/summary.ts';
import type { CallOptions, PrewarmOptions, Probe, ProbeResult } from '../../src/client/types.ts';
import { emptyAnalysis } from '../../src/core/result.ts';
import type { EngineId } from '../../src/core/types.ts';
import { createVideoFpsStore, type UseVideoFpsOptions, type VideoFpsState, type VideoFpsStore } from '../../src/react/store.ts';

interface Call {
  file: Blob;
  options: CallOptions<EngineId>;
  resolve(result: ProbeResult): void;
  reject(error: unknown): void;
}

function fakeProbe({ abortRejects = true } = {}) {
  const calls: Call[] = [];
  const prewarms: Array<PrewarmOptions<EngineId> | undefined> = [];
  const probe = {
    engines: ['own'],
    analyze: (file: Blob, options: CallOptions<EngineId> = {}) =>
      new Promise<ProbeResult>((resolve, reject) => {
        calls.push({ file, options, resolve, reject });
        if (abortRejects) options.signal?.addEventListener('abort', () => reject(new ProbeError('aborted', 'aborted')));
      }),
    prewarm: async (options?: PrewarmOptions<EngineId>) => {
      prewarms.push(options);
    },
  } as unknown as Probe<EngineId>;
  return { probe, calls, prewarms };
}

const resultOf = (name: string): ProbeResult => ({ name, size: 1, ...emptyAnalysis('mp4'), io: { reads: 1, bytesRead: 1, ms: 1 }, engine: 'own' });
const blob = (): Blob => new Blob([new Uint8Array(8)]);
const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

function mount(store: VideoFpsStore, file: Blob | null, options: UseVideoFpsOptions = {}) {
  const key = file && options.enabled !== false ? store.keyOf(options) : null;
  const read = (): VideoFpsState => store.snapshot(file, key, options);
  const renders: VideoFpsState[] = [read()];
  const unsubscribe = file && key !== null ? store.subscribe(file, key, () => renders.push(read())) : () => {};
  return { read, renders, unsubscribe };
}

describe('the framework-free store of video-fps-probe/react', () => {
  it('stays idle without a file or when disabled, and analyzes nothing', () => {
    const { probe, calls } = fakeProbe();
    const store = createVideoFpsStore(probe);
    expect(mount(store, null).read()).toMatchObject({ status: 'idle', result: null, summary: null, error: null, progress: null });
    expect(mount(store, blob(), { enabled: false }).read().status).toBe('idle');
    expect(calls).toHaveLength(0);
  });

  it('is pending from the first read, analyzes once on subscribe and gives the result with its summary', async () => {
    const { probe, calls } = fakeProbe();
    const store = createVideoFpsStore(probe);
    const file = blob();
    const view = mount(store, file);
    expect(view.renders[0].status).toBe('pending');
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe(file);
    const result = resultOf('a.mp4');
    calls[0].resolve(result);
    await settle();
    expect(view.read()).toMatchObject({ status: 'success', result, summary: summarize(result), error: null });
  });

  it('caches by Blob, then by engine and options, whatever the key order', async () => {
    const { probe, calls } = fakeProbe();
    const store = createVideoFpsStore(probe);
    const file = blob();
    mount(store, file, { engine: 'own', matroskaMode: 'exact', readAhead: { head: 4096, tail: 8192 } });
    mount(store, file, { readAhead: { tail: 8192, head: 4096 }, matroskaMode: 'exact', engine: 'own', progress: true });
    expect(calls).toHaveLength(1);
    mount(store, file, { engine: 'own' });
    mount(store, file, { engine: 'mediabunny' });
    mount(store, blob(), { engine: 'own' });
    expect(calls).toHaveLength(4);
    calls[1].resolve(resultOf('b.mp4'));
    await settle();
    const again = mount(store, file, { engine: 'own' });
    expect(again.read().status).toBe('success');
    expect(calls).toHaveLength(4);
  });

  it('runs one analysis through the double effects of StrictMode, without aborting it', async () => {
    const { probe, calls } = fakeProbe();
    const store = createVideoFpsStore(probe);
    const file = blob();
    const first = mount(store, file);
    first.unsubscribe();
    const second = mount(store, file);
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0].options.signal?.aborted).toBe(false);
    calls[0].resolve(resultOf('a.mp4'));
    await settle();
    expect(second.read().status).toBe('success');
  });

  it('aborts the analysis when the last subscriber leaves, and analyzes again on the next mount', async () => {
    const { probe, calls } = fakeProbe();
    const store = createVideoFpsStore(probe);
    const file = blob();
    const a = mount(store, file);
    const b = mount(store, file);
    a.unsubscribe();
    await settle();
    expect(calls[0].options.signal?.aborted).toBe(false);
    b.unsubscribe();
    await settle();
    expect(calls[0].options.signal?.aborted).toBe(true);
    expect(mount(store, file).read().status).toBe('pending');
    expect(calls).toHaveLength(2);
    expect(calls[1].options.signal?.aborted).toBe(false);
  });

  it('keeps a finished result after the last subscriber leaves', async () => {
    const { probe, calls } = fakeProbe();
    const store = createVideoFpsStore(probe);
    const file = blob();
    const view = mount(store, file);
    calls[0].resolve(resultOf('a.mp4'));
    await settle();
    view.unsubscribe();
    await settle();
    expect(mount(store, file).read().status).toBe('success');
    expect(calls).toHaveLength(1);
  });

  it('cancel() aborts at once, and retry() analyzes again', async () => {
    const { probe, calls } = fakeProbe();
    const store = createVideoFpsStore(probe);
    const view = mount(store, blob());
    view.read().cancel();
    expect(calls[0].options.signal?.aborted).toBe(true);
    expect(view.read().status).toBe('error');
    expect(view.read().error).toMatchObject({ name: 'ProbeError', code: 'aborted' });
    view.read().retry();
    expect(view.read()).toMatchObject({ status: 'pending', error: null });
    expect(calls).toHaveLength(2);
    calls[1].resolve(resultOf('a.mp4'));
    await settle();
    expect(view.read().status).toBe('success');
  });

  it('ignores the late result of a run that retry() replaced', async () => {
    const { probe, calls } = fakeProbe({ abortRejects: false });
    const store = createVideoFpsStore(probe);
    const view = mount(store, blob());
    view.read().retry();
    calls[0].resolve(resultOf('old.mp4'));
    await settle();
    expect(view.read().status).toBe('pending');
    calls[1].resolve(resultOf('new.mp4'));
    await settle();
    expect(view.read().result?.name).toBe('new.mp4');
  });

  it('gives a rejection as the error state, and wraps anything but a ProbeError as a load failure', async () => {
    const { probe, calls } = fakeProbe();
    const store = createVideoFpsStore(probe);
    const timeout = new ProbeError('timeout', 'timed out');
    const a = mount(store, blob());
    const b = mount(store, blob());
    calls[0].reject(timeout);
    const cause = new TypeError('Failed to fetch dynamically imported module');
    calls[1].reject(cause);
    await settle();
    expect(a.read()).toMatchObject({ status: 'error', error: timeout, result: null });
    expect(b.read().error).toMatchObject({ code: 'worker-failed', reason: 'load', cause });
  });

  it('re-renders only the subscribers that ask for progress when progress comes in', async () => {
    const { probe, calls } = fakeProbe();
    const store = createVideoFpsStore(probe);
    const file = blob();
    const lean = mount(store, file);
    const full = mount(store, file, { progress: true });
    const [leanBefore, fullBefore] = [lean.read(), full.read()];
    calls[0].options.onProgress?.({ phase: 'matroska-exact', done: 5, total: 10 });
    expect(lean.read()).toBe(leanBefore);
    expect(full.read()).not.toBe(fullBefore);
    expect(full.read().progress).toEqual({ phase: 'matroska-exact', done: 5, total: 10 });
    calls[0].resolve(resultOf('a.mp4'));
    await settle();
    expect([lean.read().status, full.read().status, full.read().progress]).toEqual(['success', 'success', null]);
  });

  it('passes host and the call options to analyze, keys host by identity and leaves the hook options out', () => {
    const { probe, calls } = fakeProbe();
    const store = createVideoFpsStore(probe);
    const file = blob();
    const host = {} as HTMLElement;
    mount(store, file, { engine: 'rvfc', host, timeoutMs: 500, progress: true });
    mount(store, file, { engine: 'rvfc', host, timeoutMs: 500 });
    mount(store, file, { engine: 'rvfc', host: {} as HTMLElement, timeoutMs: 500 });
    expect(calls).toHaveLength(2);
    expect(calls[0].options).toMatchObject({ engine: 'rvfc', host, timeoutMs: 500 });
    expect(Object.keys(calls[0].options).sort()).toEqual(['engine', 'host', 'onProgress', 'signal', 'timeoutMs']);
  });

  it('prewarms the probe with the options given', () => {
    const { probe, prewarms } = fakeProbe();
    createVideoFpsStore(probe).prewarm({ containers: ['matroska'] });
    expect(prewarms).toEqual([{ containers: ['matroska'] }]);
  });
});
