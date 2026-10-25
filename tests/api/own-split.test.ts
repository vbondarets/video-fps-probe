import { openAsBlob } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProbeClient } from '../../src/client/probe.ts';
import { mediabunny } from '../../src/plugins/mediabunny.ts';
import { mp4box } from '../../src/plugins/mp4box.ts';
import { createProbe } from '../../src/probe.ts';
import { FILES_DIR } from '../helpers/fixtures.ts';
import { fakeResult, FakeWorker } from './fake-worker.ts';
import { analyzed, customWorker, mp4File, webmFile } from './probe-helpers.ts';

const WEBM = join(FILES_DIR, 'cfr_vp9_30.webm');

beforeEach(() => {
  FakeWorker.reset();
  vi.stubGlobal('Worker', FakeWorker);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const entry = (w: FakeWorker) => String(w.label).split('/').pop();
const kinds = () => FakeWorker.instances.map(entry);
const workerOf = (name: string) => FakeWorker.instances.find((w) => entry(w) === name)!;
const names = (w: FakeWorker) => analyzed(w).map((m) => (m.type === 'analyze' ? m.name : null));

function slowFile(bytes: Uint8Array<ArrayBuffer>, name: string) {
  const read = { release: () => {} };
  const file = Object.assign(new File([bytes], name), {
    slice: () => ({ arrayBuffer: () => new Promise<ArrayBuffer>((resolve) => (read.release = () => resolve(bytes.slice(0, 4).buffer))) }),
  });
  return { file, read };
}

describe('per-container own workers', () => {
  it('routes by the first four bytes: MP4, fragmented MP4 and unknown files to the ISO BMFF worker, WebM to the Matroska worker', async () => {
    const probe = createProbe();
    const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'a.png');
    await probe.analyze(mp4File('a.mp4'));
    await probe.analyze(await openAsBlob(join(FILES_DIR, 'fmp4_cmaf.mp4')), { name: 'b.mp4' });
    await probe.analyze(png);
    await probe.analyze(webmFile('a.webm'));
    await probe.analyze(await openAsBlob(WEBM), { name: 'b.webm' });
    expect(kinds()).toEqual(['own-isobmff.worker.ts', 'own-matroska.worker.ts']);
    expect(FakeWorker.instances.map(names)).toEqual([
      ['a.mp4', 'b.mp4', 'a.png'],
      ['a.webm', 'b.webm'],
    ]);
  });

  it('sends a non-Blob to the ISO BMFF worker, which still rejects it with a protocol error', async () => {
    FakeWorker.reset('reply', (m) => (m.type === 'analyze' && !(m.file instanceof Blob) ? { type: 'error', message: 'malformed analyze request', aborted: false, code: 'protocol' } : undefined));
    await expect(createProbe().analyze({} as Blob, { name: 'x' })).rejects.toMatchObject({ name: 'ProbeError', code: 'protocol', engine: 'own' });
    expect(kinds()).toEqual(['own-isobmff.worker.ts']);
  });

  it('rejects aborted and spawns no worker when the call aborts or the probe is destroyed during the routing read', async () => {
    const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]);
    const probe = createProbe();
    const controller = new AbortController();
    const aborted = probe.analyze(slowFile(webm, 'a.webm').file, { signal: controller.signal });
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: 'ProbeError', code: 'aborted', engine: 'own' });
    const { file, read } = slowFile(webm, 'b.webm');
    const released = probe.analyze(file);
    const hanging = probe.analyze(slowFile(webm, 'c.webm').file);
    probe.destroy();
    read.release();
    await expect(released).rejects.toMatchObject({ code: 'aborted', message: 'probe destroyed', engine: 'own' });
    await expect(hanging).rejects.toMatchObject({ code: 'aborted', message: 'probe destroyed', engine: 'own' });
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it('applies workers per kind, so workers: 1 runs one MP4 and one WebM at once', async () => {
    FakeWorker.reset('manual');
    const probe = createProbe({ workers: 1 });
    const runs = [probe.analyze(mp4File('a.mp4')), probe.analyze(mp4File('b.mp4')), probe.analyze(webmFile('a.webm'))];
    await vi.waitFor(() => expect(FakeWorker.instances.flatMap((w) => w.pending)).toHaveLength(2));
    expect(kinds().sort()).toEqual(['own-isobmff.worker.ts', 'own-matroska.worker.ts']);
    const iso = workerOf('own-isobmff.worker.ts');
    const mkv = workerOf('own-matroska.worker.ts');
    mkv.answer(mkv.pending[0]!.id);
    iso.answer(iso.pending[0]!.id);
    await vi.waitFor(() => expect(iso.pending).toHaveLength(2));
    iso.answer(iso.pending[1]!.id);
    expect((await Promise.all(runs)).map((r) => r.name).sort()).toEqual(['a.mp4', 'a.webm', 'b.mp4']);
    expect(FakeWorker.instances).toHaveLength(2);
  });

  it('prewarms per container family: ISO BMFF by default, both on request, nothing for no container', async () => {
    const probe = createProbe();
    await probe.prewarm({ containers: [] });
    expect(FakeWorker.instances).toHaveLength(0);
    await probe.prewarm();
    expect(FakeWorker.instances.map((w) => [entry(w), w.posted])).toEqual([['own-isobmff.worker.ts', [{ v: 1, id: 1, type: 'warm', engines: ['own'], containers: ['isobmff'] }]]]);
    await probe.prewarm({ containers: ['matroska', 'isobmff'] });
    expect(FakeWorker.instances.map((w) => [entry(w), w.posted.at(-1)])).toEqual([
      ['own-isobmff.worker.ts', { v: 1, id: 2, type: 'warm', engines: ['own'], containers: ['isobmff'] }],
      ['own-matroska.worker.ts', { v: 1, id: 1, type: 'warm', engines: ['own'], containers: ['matroska'] }],
    ]);
  });

  it('merges the warm of own into the mp4box worker when mp4box is the default engine, which serves own too', async () => {
    const probe = createProbe({ engines: [mp4box()], engine: 'mp4box' });
    await probe.prewarm({ engines: ['own', 'mp4box'], containers: ['isobmff', 'matroska'] });
    expect(FakeWorker.instances.map((w) => [entry(w), w.posted])).toEqual([['mp4box.worker.ts', [{ v: 1, id: 1, type: 'warm', engines: ['own', 'mp4box'], containers: ['isobmff', 'matroska'] }]]]);
    await probe.analyze(webmFile(), { engine: 'own' });
    expect(kinds()).toEqual(['mp4box.worker.ts']);
  });

  it('compares own and mediabunny on a WebM in parallel, each on its own worker', async () => {
    FakeWorker.reset('manual');
    const probe = createProbe({ engines: [mediabunny()] });
    const compared = probe.compare(webmFile('a.webm'));
    await vi.waitFor(() => expect(FakeWorker.instances.flatMap((w) => w.pending)).toHaveLength(2));
    expect(kinds().sort()).toEqual(['mediabunny.worker.ts', 'own-matroska.worker.ts']);
    for (const w of FakeWorker.instances) w.answer(w.pending[0]!.id);
    const result = await compared;
    expect(Object.fromEntries(Object.entries(result.outcomes).map(([id, o]) => [id, o?.status]))).toEqual({ own: 'ok', mediabunny: 'ok' });
  });

  it('falls back from own on a WebM to mediabunny', async () => {
    FakeWorker.reset('reply', (m) => (m.type === 'analyze' && m.engine === 'own' ? { type: 'result', result: { ...fakeResult(m.name), error: 'no Tracks element' } } : undefined));
    const probe = createProbe({ engines: [mediabunny()], fallback: ['mediabunny'] });
    expect(await probe.analyze(webmFile('a.webm'))).toEqual({ ...fakeResult('a.webm', 'mediabunny'), attempts: [{ engine: 'own', error: 'no Tracks element' }] });
    expect(kinds()).toEqual(['own-matroska.worker.ts', 'mediabunny.worker.ts']);
  });

  it('rejects the jobs of a worker kind that fails to load with reason load, leaves the other kind alone and retries on the next call', async () => {
    FakeWorker.reset('manual');
    const probe = createProbe();
    const mp4 = probe.analyze(mp4File('a.mp4'));
    const webm = probe.analyze(webmFile('a.webm'));
    await vi.waitFor(() => expect(FakeWorker.instances.flatMap((w) => w.pending)).toHaveLength(2));
    const iso = workerOf('own-isobmff.worker.ts');
    workerOf('own-matroska.worker.ts').failToLoad();
    await expect(webm).rejects.toMatchObject({ name: 'ProbeError', code: 'worker-failed', reason: 'load', engine: 'own' });
    iso.answer(iso.pending[0]!.id);
    expect(await mp4).toEqual(fakeResult('a.mp4'));
    FakeWorker.reset('reply');
    expect(await probe.analyze(webmFile('b.webm'))).toEqual(fakeResult('b.webm'));
    expect(kinds()).toEqual(['own-matroska.worker.ts']);
  });

  it('terminates idle workers per kind', async () => {
    vi.useFakeTimers();
    const probe = createProbe({ idleTimeoutMs: 1000 });
    await probe.analyze(mp4File('a.mp4'));
    await vi.advanceTimersByTimeAsync(600);
    await probe.analyze(webmFile('a.webm'));
    const iso = workerOf('own-isobmff.worker.ts');
    const mkv = workerOf('own-matroska.worker.ts');
    await vi.advanceTimersByTimeAsync(400);
    expect([iso.terminated, mkv.terminated]).toEqual([true, false]);
    await vi.advanceTimersByTimeAsync(600);
    expect([iso.terminated, mkv.terminated]).toEqual([true, true]);
  });

  it('reads the first four bytes only on routes split by container', async () => {
    const slice = vi.spyOn(Blob.prototype, 'slice');
    try {
      await createProbeClient({ worker: customWorker('own') }).analyze(mp4File());
      await createProbe({ engines: [mp4box()], engine: 'mp4box' }).analyze(mp4File(), { engine: 'own' });
      expect(slice).not.toHaveBeenCalled();
      await createProbe().analyze(mp4File());
      expect(slice.mock.calls).toEqual([[0, 4]]);
    } finally {
      slice.mockRestore();
    }
  });
});
