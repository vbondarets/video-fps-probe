import { openAsBlob } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkerResponse } from '../../src/worker/protocol.ts';
import { FILES_DIR } from '../helpers/fixtures.ts';

const MP4 = join(FILES_DIR, 'cfr_h264_30.mp4');
const WEBM = join(FILES_DIR, 'cfr_vp9_30.webm');

async function serveEntry(entry: string) {
  const replies: WorkerResponse[] = [];
  const self = { onmessage: null as ((e: { data: unknown }) => void) | null, postMessage: (m: WorkerResponse) => replies.push(m) };
  vi.stubGlobal('self', self);
  vi.resetModules();
  await import(entry);
  let id = 0;
  return async (data: Record<string, unknown>): Promise<WorkerResponse> => {
    const current = ++id;
    self.onmessage?.({ data: { v: 1, id: current, options: {}, ...data } });
    return vi.waitFor(
      () => {
        const r = replies.find((x) => x.id === current && x.type !== 'progress');
        if (!r) throw new Error('pending');
        return r;
      },
      { timeout: 30_000 },
    );
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('prebuilt worker entries', () => {
  it('the own worker serves only own', async () => {
    const send = await serveEntry('../../src/worker/own.worker.ts');
    const file = await openAsBlob(MP4);
    expect(await send({ type: 'analyze', file, name: 'a.mp4', engine: 'own' })).toMatchObject({ type: 'result', result: { name: 'a.mp4', engine: 'own' } });
    for (const engine of ['mp4box', 'mediabunny']) expect(await send({ type: 'analyze', file, name: 'a.mp4', engine })).toMatchObject({ type: 'error', code: 'unknown-engine' });
  });

  it('the mp4box worker serves own and mp4box, and skips Matroska for mp4box', async () => {
    const send = await serveEntry('../../src/worker/mp4box.worker.ts');
    const file = await openAsBlob(MP4);
    expect(await send({ type: 'analyze', file, name: 'a.mp4', engine: 'own' })).toMatchObject({ type: 'result', result: { engine: 'own' } });
    expect(await send({ type: 'analyze', file, name: 'a.mp4', engine: 'mp4box' })).toMatchObject({ type: 'result', result: { engine: 'mp4box' } });
    expect(await send({ type: 'analyze', file: await openAsBlob(WEBM), name: 'a.webm', engine: 'mp4box' })).toMatchObject({ type: 'skipped', reason: 'unsupported-container' });
    expect(await send({ type: 'analyze', file, name: 'a.mp4', engine: 'mediabunny' })).toMatchObject({ type: 'error', code: 'unknown-engine' });
  });

  it('the mediabunny worker serves own and mediabunny', async () => {
    const send = await serveEntry('../../src/worker/mediabunny.worker.ts');
    const file = await openAsBlob(WEBM);
    expect(await send({ type: 'analyze', file, name: 'a.webm', engine: 'own' })).toMatchObject({ type: 'result', result: { engine: 'own' } });
    expect(await send({ type: 'analyze', file, name: 'a.webm', engine: 'mediabunny' })).toMatchObject({ type: 'result', result: { engine: 'mediabunny' } });
    expect(await send({ type: 'warm', engines: ['own', 'mediabunny'], containers: ['isobmff', 'matroska'] })).toMatchObject({ type: 'warmed' });
    expect(await send({ type: 'analyze', file, name: 'a.webm', engine: 'mp4box' })).toMatchObject({ type: 'error', code: 'unknown-engine' });
  });
});
