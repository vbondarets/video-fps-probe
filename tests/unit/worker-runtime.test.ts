import { openAsBlob } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileResult } from '../../src/core/types.ts';
import type { EngineModule } from '../../src/plugins/types.ts';
import type { WorkerResponse } from '../../src/worker/protocol.ts';
import { ownEngine, serveProbeWorker, type EngineSource } from '../../src/worker/runtime.ts';
import { FILES_DIR } from '../helpers/fixtures.ts';

const MP4 = join(FILES_DIR, 'cfr_h264_30.mp4');
const WEBM = join(FILES_DIR, 'cfr_vp9_30.webm');

class FakeSelf {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  replies: WorkerResponse[] = [];

  postMessage(message: WorkerResponse): void {
    this.replies.push(message);
  }

  send(data: unknown): void {
    this.onmessage?.({ data });
  }

  settled(id: number): Promise<WorkerResponse> {
    return vi.waitFor(() => {
      const reply = this.replies.find((r) => r.id === id && r.type !== 'progress');
      if (!reply) throw new Error(`no reply for ${id} yet`);
      return reply;
    });
  }
}

function serve(engines: Parameters<typeof serveProbeWorker>[0]): FakeSelf {
  const fake = new FakeSelf();
  vi.stubGlobal('self', fake);
  serveProbeWorker(engines);
  return fake;
}

const fakeEngine = (containers: EngineModule['containers']): EngineModule & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    containers,
    run: async (blob, name) => {
      calls.push(name);
      return { name, size: blob.size, engine: 'mp4box' } as FileResult;
    },
  };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('serveProbeWorker', () => {
  it('runs the own engine on a file and replies with v1, the request id and the passed name', async () => {
    const self = serve({ own: ownEngine });
    self.send({ v: 1, type: 'analyze', id: 7, file: await openAsBlob(MP4), name: 'renamed.mp4', engine: 'own', options: {} });
    const reply = await self.settled(7);
    expect(reply).toMatchObject({ v: 1, type: 'result', id: 7 });
    if (reply.type !== 'result') return;
    expect(reply.result.name).toBe('renamed.mp4');
    expect(reply.result.engine).toBe('own');
    expect(reply.result.videoTracks[0].avgFps?.value).toBeCloseTo(30, 6);
  });

  it('skips a container the engine does not handle without running it', async () => {
    const mp4box = fakeEngine(['isobmff']);
    const self = serve({ own: ownEngine, mp4box });
    self.send({ v: 1, type: 'analyze', id: 1, file: await openAsBlob(WEBM), name: 'a.webm', engine: 'mp4box', options: {} });
    expect(await self.settled(1)).toEqual({ v: 1, type: 'skipped', id: 1, reason: 'unsupported-container' });
    self.send({ v: 1, type: 'analyze', id: 2, file: new Blob([new Uint8Array(64)]), name: 'zeros.bin', engine: 'mp4box', options: {} });
    expect(await self.settled(2)).toMatchObject({ type: 'skipped', reason: 'unsupported-container' });
    self.send({ v: 1, type: 'analyze', id: 3, file: await openAsBlob(MP4), name: 'b.mp4', engine: 'mp4box', options: {} });
    expect(await self.settled(3)).toMatchObject({ type: 'result', result: { name: 'b.mp4' } });
    expect(mp4box.calls).toEqual(['b.mp4']);
  });

  it('runs an engine that handles any container on every file', async () => {
    const any = fakeEngine('any');
    const self = serve({ own: ownEngine, mediabunny: any });
    self.send({ v: 1, type: 'analyze', id: 1, file: new Blob([new Uint8Array(64)]), name: 'zeros.bin', engine: 'mediabunny', options: {} });
    expect(await self.settled(1)).toMatchObject({ type: 'result' });
    expect(any.calls).toEqual(['zeros.bin']);
  });

  it('loads a lazy engine source once, on first use', async () => {
    const engine = fakeEngine(['isobmff', 'matroska']);
    const source = vi.fn<() => Promise<EngineModule>>(async () => engine);
    const self = serve({ own: ownEngine, mediabunny: source as EngineSource });
    expect(source).not.toHaveBeenCalled();
    const file = await openAsBlob(MP4);
    self.send({ v: 1, type: 'analyze', id: 1, file, name: 'a.mp4', engine: 'mediabunny', options: {} });
    self.send({ v: 1, type: 'analyze', id: 2, file, name: 'b.mp4', engine: 'mediabunny', options: {} });
    await Promise.all([self.settled(1), self.settled(2)]);
    expect(source).toHaveBeenCalledTimes(1);
    expect(engine.calls.sort()).toEqual(['a.mp4', 'b.mp4']);
  });

  it('retries a lazy engine source after a failed load', async () => {
    const engine = fakeEngine('any');
    const source = vi
      .fn<() => Promise<EngineModule>>()
      .mockRejectedValueOnce(new Error('Failed to fetch dynamically imported module'))
      .mockResolvedValue(engine);
    const self = serve({ own: ownEngine, mp4box: source as EngineSource });
    self.send({ v: 1, type: 'analyze', id: 1, file: new Blob([new Uint8Array(8)]), name: 'a.mp4', engine: 'mp4box', options: {} });
    const failed = await self.settled(1);
    expect(failed).toMatchObject({ type: 'error', id: 1, aborted: false, message: 'Failed to fetch dynamically imported module' });
    expect(failed).not.toHaveProperty('code');
    self.send({ v: 1, type: 'analyze', id: 2, file: new Blob([new Uint8Array(8)]), name: 'b.mp4', engine: 'mp4box', options: {} });
    expect(await self.settled(2)).toMatchObject({ type: 'result', result: { name: 'b.mp4' } });
    self.send({ v: 1, type: 'analyze', id: 3, file: new Blob([new Uint8Array(8)]), name: 'c.mp4', engine: 'mp4box', options: {} });
    await self.settled(3);
    expect(source).toHaveBeenCalledTimes(2);
    expect(engine.calls).toEqual(['b.mp4', 'c.mp4']);
  });

  it('replies unknown-engine for an engine this worker does not serve', async () => {
    const self = serve({ own: ownEngine });
    self.send({ v: 1, type: 'analyze', id: 4, file: new Blob([new Uint8Array(8)]), name: 'a.mp4', engine: 'mp4box', options: {} });
    expect(await self.settled(4)).toMatchObject({ v: 1, type: 'error', id: 4, aborted: false, code: 'unknown-engine' });
    self.send({ v: 1, type: 'analyze', id: 5, file: new Blob([new Uint8Array(8)]), name: 'a.mp4', engine: 'constructor', options: {} });
    expect(await self.settled(5)).toMatchObject({ type: 'error', code: 'unknown-engine' });
    self.send({ v: 1, type: 'warm', id: 6, engines: ['mediabunny'], containers: [] });
    expect(await self.settled(6)).toMatchObject({ type: 'error', code: 'unknown-engine' });
  });

  it('replies protocol for a missing or different version and for an unknown request type', async () => {
    const self = serve({ own: ownEngine });
    self.send({ type: 'analyze', id: 1, file: new Blob([]), name: 'a.mp4', engine: 'own', options: {} });
    expect(await self.settled(1)).toMatchObject({ v: 1, type: 'error', id: 1, code: 'protocol' });
    self.send({ v: 2, type: 'analyze', id: 2, file: new Blob([]), name: 'a.mp4', engine: 'own', options: {} });
    expect(await self.settled(2)).toMatchObject({ type: 'error', code: 'protocol' });
    self.send({ v: 1, type: 'explode', id: 3 });
    expect(await self.settled(3)).toMatchObject({ type: 'error', code: 'protocol' });
    self.send(null);
    expect(await self.settled(0)).toMatchObject({ type: 'error', code: 'protocol' });
  });

  it('warms the requested engines and the own parsers for the requested containers', async () => {
    const warmed: string[][] = [];
    const engine: EngineModule = { ...fakeEngine(['isobmff']), warm: async (containers) => void warmed.push([...containers]) };
    const source = vi.fn<() => Promise<EngineModule>>(async () => engine);
    const self = serve({ own: ownEngine, mp4box: source as EngineSource });
    self.send({ v: 1, type: 'warm', id: 1, engines: ['own', 'mp4box'], containers: ['isobmff', 'matroska'] });
    expect(await self.settled(1)).toEqual({ v: 1, type: 'warmed', id: 1 });
    expect(source).toHaveBeenCalledTimes(1);
    expect(warmed).toEqual([['isobmff', 'matroska']]);
  });

  it('aborts a running job on cancel and reports it as aborted', async () => {
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    const slow: EngineModule = {
      containers: 'any',
      run: (_blob, name, opts) =>
        new Promise<FileResult>((resolve, reject) => {
          started();
          opts.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
          setTimeout(() => resolve({ name } as FileResult), 10_000);
        }),
    };
    const self = serve({ own: slow });
    self.send({ v: 1, type: 'analyze', id: 9, file: new Blob([new Uint8Array(8)]), name: 'a.mp4', engine: 'own', options: {} });
    await running;
    self.send({ v: 1, type: 'cancel', id: 9 });
    expect(await self.settled(9)).toMatchObject({ v: 1, type: 'error', id: 9, aborted: true });
  });

  it('throttles progress to one message per 50 ms', async () => {
    const chatty: EngineModule = {
      containers: 'any',
      run: async (_blob, name, opts) => {
        for (let i = 0; i < 1000; i++) opts.onProgress?.({ phase: 'scan', done: i, total: 1000 });
        return { name } as FileResult;
      },
    };
    const self = serve({ own: chatty });
    self.send({ v: 1, type: 'analyze', id: 1, file: new Blob([]), name: 'a.mp4', engine: 'own', options: {} });
    await self.settled(1);
    const progress = self.replies.filter((r) => r.type === 'progress');
    expect(progress.length).toBeGreaterThanOrEqual(1);
    expect(progress.length).toBeLessThan(5);
  });
});
