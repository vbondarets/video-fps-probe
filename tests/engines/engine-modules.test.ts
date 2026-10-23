import { openAsBlob } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as mediabunny from '../../src/engines/mediabunny.ts';
import * as mp4box from '../../src/engines/mp4box.ts';
import * as rvfc from '../../src/engines/rvfc.ts';
import type { EngineModule } from '../../src/plugins/types.ts';
import type { WorkerResponse } from '../../src/worker/protocol.ts';
import { ownEngine, serveProbeWorker } from '../../src/worker/runtime.ts';
import { FILES_DIR } from '../helpers/fixtures.ts';

const modules: Record<string, EngineModule> = { mp4box, mediabunny, rvfc };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('engine adapters as engine modules', () => {
  it('export run and containers', () => {
    expect(mp4box.run).toBe(mp4box.analyzeWithMp4box);
    expect(mp4box.containers).toEqual(['isobmff']);
    expect(mediabunny.run).toBe(mediabunny.analyzeWithMediabunny);
    expect(mediabunny.containers).toBe('any');
    expect(rvfc.containers).toBe('any');
    for (const m of Object.values(modules)) expect(typeof m.run).toBe('function');
  });

  it('run the library engines with the passed name', async () => {
    const blob = await openAsBlob(join(FILES_DIR, 'cfr_h264_30.mp4'));
    for (const m of [mp4box, mediabunny]) {
      const r = await m.run(blob, 'named.mp4', {});
      expect(r.name).toBe('named.mp4');
      expect(r.error).toBeNull();
      expect(r.videoTracks[0].avgFps?.value).toBeCloseTo(30, 6);
    }
  });

  it('rVFC run needs a Blob and a host, then delegates with the passed name', async () => {
    const blob = new Blob([new Uint8Array(8)], { type: 'video/mp4' });
    const host = { append() {} } as unknown as HTMLElement;
    await expect(rvfc.run({ size: 0, slice: () => ({ arrayBuffer: async () => new ArrayBuffer(0) }) }, 'a.mp4', { host })).rejects.toThrow(TypeError);
    await expect(rvfc.run(blob, 'a.mp4', {})).rejects.toThrow(/host element/);
    const plain = { muted: false, playsInline: false, width: 0, removeAttribute() {}, load() {}, remove() {}, pause() {} };
    vi.stubGlobal('document', { createElement: () => plain });
    const r = await rvfc.run(blob, 'b.mp4', { host });
    expect(r).toMatchObject({ name: 'b.mp4', engine: 'rvfc' });
    expect(r.error).toContain('requestVideoFrameCallback');
  });
});

describe('worker runtime with the real engine modules', () => {
  it('loads an engine module through import() and gates its containers', async () => {
    const replies: WorkerResponse[] = [];
    const fake = { onmessage: null as ((e: { data: unknown }) => void) | null, postMessage: (m: WorkerResponse) => replies.push(m) };
    vi.stubGlobal('self', fake);
    serveProbeWorker({ own: ownEngine, mp4box: () => import('../../src/engines/mp4box.ts') });
    const settled = (id: number) =>
      vi.waitFor(() => {
        const r = replies.find((x) => x.id === id && x.type !== 'progress');
        if (!r) throw new Error('pending');
        return r;
      });
    fake.onmessage!({ data: { v: 1, type: 'analyze', id: 1, file: await openAsBlob(join(FILES_DIR, 'cfr_vp9_30.webm')), name: 'a.webm', engine: 'mp4box', options: {} } });
    expect(await settled(1)).toMatchObject({ type: 'skipped', reason: 'unsupported-container' });
    fake.onmessage!({ data: { v: 1, type: 'analyze', id: 2, file: await openAsBlob(join(FILES_DIR, 'cfr_h264_30.mp4')), name: 'b.mp4', engine: 'mp4box', options: {} } });
    const reply = await settled(2);
    expect(reply).toMatchObject({ type: 'result', result: { name: 'b.mp4', engine: 'mp4box' } });
  });

  it('runs mediabunny on files the own sniffer cannot classify, so it reports its own error with its reads', async () => {
    const replies: WorkerResponse[] = [];
    const fake = { onmessage: null as ((e: { data: unknown }) => void) | null, postMessage: (m: WorkerResponse) => replies.push(m) };
    vi.stubGlobal('self', fake);
    serveProbeWorker({ own: ownEngine, mp4box: () => import('../../src/engines/mp4box.ts'), mediabunny: () => import('../../src/engines/mediabunny.ts') });
    const settled = (id: number) =>
      vi.waitFor(() => {
        const r = replies.find((x) => x.id === id && x.type !== 'progress');
        if (!r) throw new Error('pending');
        return r;
      });
    const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Uint8Array(4088)])]);
    const ts = new Blob([new Uint8Array(188 * 8).map((_, i) => (i % 188 === 0 ? 0x47 : 0))]);
    const ogg = new Blob([new Uint8Array([0x4f, 0x67, 0x67, 0x53, ...new Uint8Array(1020)])]);
    const files: [string, Blob][] = [
      ['a.png', png],
      ['a.ts', ts],
      ['a.ogg', ogg],
      ['empty.mp4', new Blob([])],
    ];
    let id = 0;
    for (const [name, file] of files) {
      fake.onmessage!({ data: { v: 1, type: 'analyze', id: ++id, file, name, engine: 'mediabunny', options: {} } });
      const reply = await settled(id);
      expect(reply).toMatchObject({ type: 'result', result: { name, engine: 'mediabunny', error: expect.stringMatching(/\S/) } });
      if (reply.type === 'result' && file.size > 0) expect(reply.result.io.reads).toBeGreaterThan(0);
      fake.onmessage!({ data: { v: 1, type: 'analyze', id: ++id, file, name, engine: 'mp4box', options: {} } });
      expect(await settled(id)).toMatchObject({ type: 'skipped', reason: 'unsupported-container', family: null });
    }
  });
});
