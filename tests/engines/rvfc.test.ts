import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { estimateWithRvfc } from '../../src/engines/rvfc.ts';
import type { RvfcResult } from '../../src/engines/types.ts';
import { expectContract } from './engine-contract.ts';
import { FakeVideo, patternTimes, uniformTimes, type FakeVideoConfig } from './fake-video.ts';

interface Harness {
  video: FakeVideo;
  host: { appended: unknown[]; append(node: unknown): void };
  file: File;
}

let revoked: string[] = [];
let created: string[] = [];

function install(config: FakeVideoConfig, options: { rafWorks?: boolean } = {}): Harness {
  const video = new FakeVideo(config);
  const host = {
    appended: [] as unknown[],
    append(node: unknown) {
      this.appended.push(node);
    },
  };
  vi.stubGlobal('document', { createElement: () => video });
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
    if (options.rafWorks === false) return 0;
    return setTimeout(() => cb(performance.now()), 1000 / config.hz) as unknown as number;
  });
  const file = new File([new Uint8Array(2048)], 'clip.mp4', { type: 'video/mp4' });
  return { video, host, file };
}

async function drive<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let i = 0; !settled && i < 4000; i++) await vi.advanceTimersByTimeAsync(20);
  return promise;
}

async function estimate(h: Harness, signal?: AbortSignal): Promise<RvfcResult> {
  return drive(estimateWithRvfc(h.file, { host: h.host as unknown as HTMLElement, signal }));
}

beforeEach(() => {
  vi.useFakeTimers();
  revoked = [];
  created = [];
  const create = URL.createObjectURL.bind(URL);
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    const url = create(blob);
    created.push(url);
    return url;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
    revoked.push(url);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function expectCleanedUp(h: Harness): void {
  expect(h.video.removed).toBe(true);
  expect(h.video.hasSrc).toBe(false);
  expect(created).toHaveLength(1);
  expect(revoked).toEqual(created);
}

describe('estimateWithRvfc on a simulated display', () => {
  it('estimates a 25 fps clip in a single pass on a 50 Hz display', async () => {
    const h = install({ hz: 50, times: uniformTimes(25, 20), duration: 20 });
    const r = await estimate(h);
    expectContract(r, 'rvfc', 'clip.mp4', 2048, { noReads: true });
    expect(r.error).toBeNull();
    const t = r.videoTracks[0];
    expect(t.avgFps).toMatchObject({ num: 25, den: 1 });
    expect(t.nominalFps).toMatchObject({ num: 25, den: 1, kind: 'snapped' });
    expect(t.isVfr).toBe(false);
    expect(t.provenance.avgFps).toBe('estimated');
    expect(t.provenance.minFps).toBe('estimated');
    expect(t.warnings[0]).toContain('approximate');
    expect(r.rvfc!.passes).toHaveLength(1);
    expect(r.rvfc!.rate).toBe(1);
    expect(r.rvfc!.displayHz).toBeCloseTo(50, 0);
    expect(r.rvfc!.confidence).toBe('high');
    expect(r.rvfc!.flags).toEqual([]);
    expect(r.io).toMatchObject({ reads: 0, bytesRead: 0 });
    expect(r.primaryTrackId).toBe(1);
    expect(h.host.appended).toEqual([h.video]);
    expect(h.video.muted).toBe(true);
    expect(h.video.playsInline).toBe(true);
    expectCleanedUp(h);
  });

  it('snaps 24000/1001 content to the NTSC rate', async () => {
    const h = install({ hz: 125, times: uniformTimes(24000 / 1001, 20), duration: 20 });
    const r = await estimate(h);
    expect(r.error).toBeNull();
    expect(r.videoTracks[0].avgFps).toMatchObject({ num: 24000, den: 1001 });
  });

  it('slows playback down when the content is faster than half the refresh rate', async () => {
    const h = install({ hz: 50, times: uniformTimes(100, 60), duration: 60 });
    const r = await estimate(h);
    expect(r.error).toBeNull();
    const rvfc = r.rvfc!;
    expect(rvfc.passes.length).toBeGreaterThanOrEqual(3);
    expect(rvfc.passes[0].fps).toBeLessThan(60);
    expect(rvfc.rate).toBeLessThanOrEqual(0.25);
    expect(r.videoTracks[0].avgFps).toMatchObject({ num: 100, den: 1 });
    expect(rvfc.flags).toEqual([]);
    expectCleanedUp(h);
  });

  it('restarts from the beginning so a 3 second clip survives several slow passes', async () => {
    const h = install({ hz: 50, times: uniformTimes(100, 3), duration: 3 });
    const r = await estimate(h);
    expect(r.error).toBeNull();
    expect(r.rvfc!.passes.length).toBeGreaterThanOrEqual(3);
    expect(r.videoTracks[0].avgFps).toMatchObject({ num: 100, den: 1 });
    expect(r.rvfc!.flags).toEqual([]);
  });

  it('needs one halving and a confirming pass for content at the refresh rate', async () => {
    const h = install({ hz: 50, times: uniformTimes(50, 60), duration: 60 });
    const r = await estimate(h);
    expect(r.error).toBeNull();
    expect(r.rvfc!.passes).toHaveLength(2);
    expect(r.rvfc!.rate).toBe(0.5);
    expect(r.videoTracks[0].avgFps).toMatchObject({ num: 50, den: 1 });
  });

  it('stops chasing agreement once a valid pass shows a variable rate', async () => {
    const h = install({ hz: 100, times: patternTimes([0.04, 0.04, 0.02], 30), duration: 30 });
    const r = await estimate(h);
    expect(r.rvfc!.passes).toHaveLength(1);
  });

  it('snaps through the window average when 1 ms timestamps blur the typical delta', async () => {
    const quantized = Array.from({ length: 1200 }, (_, i) => Math.floor((i * 1000) / 60 + 0.5) / 1000);
    const h = install({ hz: 125, times: quantized, duration: 20 });
    const r = await estimate(h);
    expect(r.error).toBeNull();
    expect(r.videoTracks[0].avgFps).toMatchObject({ num: 60, den: 1 });
    expect(r.videoTracks[0].isVfr).toBe(false);
  });

  it('flags a variable rate seen inside the window', async () => {
    const h = install({ hz: 100, times: patternTimes([0.04, 0.04, 0.02], 30), duration: 30 });
    const r = await estimate(h);
    expect(r.error).toBeNull();
    const t = r.videoTracks[0];
    expect(t.isVfr).toBe(true);
    expect(t.vfrRatio).toBeGreaterThan(0.2);
    expect(t.minFps!.value).toBeCloseTo(25, 1);
    expect(t.maxFps!.value).toBeCloseTo(50, 1);
    expect(r.rvfc!.flags).toContain('vfr');
    expect(r.rvfc!.confidence).not.toBe('high');
    expect(t.warnings).toContain('vfr');
  });

  it('stops at the end of a short clip and flags the small sample', async () => {
    const h = install({ hz: 50, times: uniformTimes(25, 0.6), duration: 0.6 });
    const r = await estimate(h);
    expect(r.error).toBeNull();
    expect(r.rvfc!.flags).toContain('few-samples');
    expect(r.rvfc!.confidence).not.toBe('high');
    expectCleanedUp(h);
  });

  it('reports an unplayable codec with the browser message and cleans up', async () => {
    const h = install({ hz: 50, times: [], duration: 0, failure: 'MEDIA_ELEMENT_ERROR: Format error', canPlay: '' });
    const r = await estimate(h);
    expect(r.error).toContain('unplayable');
    expect(r.error).toContain('Format error');
    expect(r.error).toContain('canPlayType=');
    expect(r.videoTracks).toEqual([]);
    expect(r.rvfc).toBeUndefined();
    expectCleanedUp(h);
  });

  it('reports files without a decodable video track', async () => {
    const h = install({ hz: 50, times: [], duration: 5, width: 0 });
    const r = await estimate(h);
    expect(r.error).toBe('no playable video track');
    expectCleanedUp(h);
  });

  it('reports a hidden page instead of waiting forever', async () => {
    const h = install({ hz: 50, times: uniformTimes(25, 20), duration: 20 }, { rafWorks: false });
    const r = await estimate(h);
    expect(r.error).toContain('not visible');
    expectCleanedUp(h);
  });

  it('reports missing requestVideoFrameCallback support', async () => {
    const plain = { muted: false, playsInline: false, width: 0, removeAttribute() {}, load() {}, remove() {}, pause() {} };
    vi.stubGlobal('document', { createElement: () => plain });
    const file = new File([new Uint8Array(8)], 'a.mp4', { type: 'video/mp4' });
    const host = { append() {} } as unknown as HTMLElement;
    const r = await drive(estimateWithRvfc(file, { host }));
    expect(r.error).toContain('requestVideoFrameCallback');
  });

  it('rethrows an abort raised during playback and still cleans up', async () => {
    const h = install({ hz: 50, times: uniformTimes(25, 20), duration: 20 });
    const controller = new AbortController();
    const promise = estimateWithRvfc(h.file, { host: h.host as unknown as HTMLElement, signal: controller.signal });
    const settled = promise.then(
      () => 'resolved',
      (e: unknown) => (e as { name?: string }).name,
    );
    await vi.advanceTimersByTimeAsync(1000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(200);
    expect(await settled).toBe('AbortError');
    expectCleanedUp(h);
  });

  it('rejects immediately for a signal that is already aborted', async () => {
    const h = install({ hz: 50, times: uniformTimes(25, 20), duration: 20 });
    const controller = new AbortController();
    controller.abort();
    await expect(estimateWithRvfc(h.file, { host: h.host as unknown as HTMLElement, signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expectCleanedUp(h);
  });

  it('reports progress per pass', async () => {
    const h = install({ hz: 50, times: uniformTimes(100, 60), duration: 60 });
    const phases: string[] = [];
    const r = await drive(
      estimateWithRvfc(h.file, { host: h.host as unknown as HTMLElement, onProgress: (p) => phases.push(`${p.phase}:${p.done}/${p.total}`) }),
    );
    expect(r.error).toBeNull();
    expect(phases.length).toBe(r.rvfc!.passes.length);
    expect(phases[0]).toBe('play x1:0/5');
  });
});
