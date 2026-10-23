import { existsSync, openAsBlob } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FILES_DIR } from '../helpers/fixtures.ts';

const loads = vi.hoisted(() => ({ mp4box: 0, mediabunny: 0 }));

vi.mock('mp4box', async (importOriginal) => {
  loads.mp4box++;
  return importOriginal();
});

vi.mock('mediabunny', async (importOriginal) => {
  loads.mediabunny++;
  return importOriginal();
});

const ENTRIES = [
  '../../src/index.ts',
  '../../src/lazy.ts',
  '../../src/client/index.ts',
  '../../src/client/lazy.ts',
  '../../src/plugins/own.ts',
  '../../src/plugins/mp4box.ts',
  '../../src/plugins/mediabunny.ts',
  '../../src/plugins/rvfc.ts',
  '../../src/worker/runtime.ts',
];

class RecordingWorker {
  static created: { url: URL; options: WorkerOptions | undefined }[] = [];

  constructor(url: URL, options?: WorkerOptions) {
    RecordingWorker.created.push({ url, options });
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  RecordingWorker.created = [];
});

describe('lazy engine peers', () => {
  it('importing any entry loads no engine peer', async () => {
    for (const entry of ENTRIES) await import(entry);
    expect(loads).toEqual({ mp4box: 0, mediabunny: 0 });
  });

  it('describes each engine without loading it', async () => {
    const { ownDescriptor } = await import('../../src/plugins/own.ts');
    const { mp4box } = await import('../../src/plugins/mp4box.ts');
    const { mediabunny } = await import('../../src/plugins/mediabunny.ts');
    const { rvfc } = await import('../../src/plugins/rvfc.ts');
    const descriptors = [ownDescriptor, mp4box(), mediabunny(), rvfc()];
    expect(descriptors.map((d) => [d.id, d.thread, typeof d.createWorker])).toEqual([
      ['own', 'worker', 'function'],
      ['mp4box', 'worker', 'function'],
      ['mediabunny', 'worker', 'function'],
      ['rvfc', 'main', 'undefined'],
    ]);
    expect(loads).toEqual({ mp4box: 0, mediabunny: 0 });
  });

  it('creates module workers from prebuilt entries that exist', async () => {
    vi.stubGlobal('Worker', RecordingWorker);
    const { ownDescriptor } = await import('../../src/plugins/own.ts');
    const { mp4box } = await import('../../src/plugins/mp4box.ts');
    const { mediabunny } = await import('../../src/plugins/mediabunny.ts');
    for (const d of [ownDescriptor, mp4box(), mediabunny()]) d.createWorker!();
    expect(RecordingWorker.created.map(({ url }) => url.pathname.split('/').slice(-2).join('/'))).toEqual(['worker/own.worker.ts', 'worker/mp4box.worker.ts', 'worker/mediabunny.worker.ts']);
    for (const { url, options } of RecordingWorker.created) {
      expect(options).toEqual({ type: 'module' });
      expect(existsSync(fileURLToPath(url))).toBe(true);
    }
    expect(loads).toEqual({ mp4box: 0, mediabunny: 0 });
  });

  it('loads a peer only when its descriptor loads the engine, and only that peer', async () => {
    const { mp4box } = await import('../../src/plugins/mp4box.ts');
    const { mediabunny } = await import('../../src/plugins/mediabunny.ts');
    const { ownDescriptor } = await import('../../src/plugins/own.ts');
    const own = await ownDescriptor.load();
    expect(own.containers).toBe('any');
    for (const d of [mp4box(), mediabunny()]) expect(await d.loadOwn!()).toBe(own);
    expect(loads).toEqual({ mp4box: 0, mediabunny: 0 });
    const m = await mp4box().load();
    expect(m.containers).toEqual(['isobmff']);
    expect(loads).toEqual({ mp4box: 1, mediabunny: 0 });
    const blob = await openAsBlob(join(FILES_DIR, 'cfr_h264_30.mp4'));
    expect((await m.run(blob, 'a.mp4', {})).engine).toBe('mp4box');
    const b = await mediabunny().load();
    expect(b.containers).toBe('any');
    expect((await b.run(blob, 'a.mp4', {})).engine).toBe('mediabunny');
    expect(loads).toEqual({ mp4box: 1, mediabunny: 1 });
  });

  it('rVFC needs a DOM, takes its host from the call, then from the descriptor option, and loads no peer', async () => {
    const before = { ...loads };
    const { rvfc } = await import('../../src/plugins/rvfc.ts');
    const blob = new Blob([new Uint8Array(8)], { type: 'video/mp4' });
    await expect((await rvfc().load()).run(blob, 'a.mp4', {})).rejects.toMatchObject({ name: 'ProbeError', code: 'unsupported-environment', engine: 'rvfc' });
    const appended: string[] = [];
    class FakeVideo {
      muted = false;
      playsInline = false;
      width = 0;
      error = null;
      onerror: (() => void) | null = null;
      requestVideoFrameCallback() {}
      canPlayType = () => '';
      removeAttribute() {}
      load() {}
      remove() {}
      set src(_: string) {
        queueMicrotask(() => this.onerror?.());
      }
    }
    const video = () => new FakeVideo();
    vi.stubGlobal('document', { createElement: video });
    const host = (label: string) => ({ append: () => appended.push(label) }) as unknown as HTMLElement;
    await expect((await rvfc().load()).run(blob, 'a.mp4', {})).rejects.toThrow(/host element/);
    const fromOption = await (await rvfc({ host: () => host('option') }).load()).run(blob, 'b.mp4', {});
    expect(fromOption).toMatchObject({ name: 'b.mp4', engine: 'rvfc' });
    expect(fromOption.error).toMatch(/^unplayable/);
    const fixed = await rvfc({ host: host('fixed') }).load();
    await fixed.run(blob, 'c.mp4', { host: host('call') } as object);
    await fixed.run(blob, 'd.mp4', {});
    expect(appended).toEqual(['option', 'call', 'fixed']);
    expect(loads).toEqual(before);
  });
});
