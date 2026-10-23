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
    expect(mediabunny.containers).toEqual(['isobmff', 'matroska']);
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
});
