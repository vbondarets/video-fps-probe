import { openAsBlob, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { STANDALONE } from '../../scripts/build-lib.mjs';
import type { ProbeResult } from '../../src/index.ts';
import type { WorkerResponse } from '../../src/worker/protocol.ts';
import { FILES_DIR, REPO_ROOT, loadManifest } from '../helpers/fixtures.ts';

const DIST = join(REPO_ROOT, 'dist');
const dist = (await import(new URL('../../dist/index.js', import.meta.url).href)) as { analyze(input: Blob, options?: { name?: string }): Promise<ProbeResult> };

const fixtures = loadManifest().filter((e) => e.committed);
const familyOf = (container: string) => (container === 'mp4' || container === 'mov' ? 'isobmff' : container === 'webm' || container === 'matroska' ? 'matroska' : null);
const WRONG: Record<string, string> = { 'own-isobmff.worker': 'the own ISO BMFF worker does not read Matroska', 'own-matroska.worker': 'the own Matroska worker does not read ISO BMFF' };
const SERVES = { 'own.worker': null, 'own-isobmff.worker': 'isobmff', 'own-matroska.worker': 'matroska' } as const;

const withoutTiming = (r: ProbeResult) => ({ ...r, io: { reads: r.io.reads, bytesRead: r.io.bytesRead } });

function standaloneWorker(name: string) {
  const replies: WorkerResponse[] = [];
  const self = { onmessage: null as ((event: { data: unknown }) => void) | null, postMessage: (m: WorkerResponse) => replies.push(m) };
  runInNewContext(readFileSync(join(DIST, 'standalone', `${name}.js`), 'utf8'), { self, Blob, File, performance, AbortController, TextDecoder, setTimeout, clearTimeout, console, queueMicrotask }, { filename: `${name}.js` });
  let id = 0;
  return (file: Blob, fileName: string): Promise<ProbeResult> => {
    const current = ++id;
    self.onmessage?.({ data: { v: 1, id: current, type: 'analyze', file, name: fileName, engine: 'own', options: {} } });
    return new Promise((resolve, reject) => {
      const poll = () => {
        const reply = replies.find((r) => r.id === current && r.type !== 'progress');
        if (!reply) return void setTimeout(poll, 1);
        if (reply.type === 'result') resolve(JSON.parse(JSON.stringify(reply.result)) as ProbeResult);
        else reject(new Error(`unexpected reply ${JSON.stringify(reply)}`));
      };
      poll();
    });
  };
}

describe('standalone worker files', () => {
  it('are the combined own worker and one worker per container family', () => {
    expect(STANDALONE).toEqual(Object.keys(SERVES));
    expect(fixtures.length).toBeGreaterThan(100);
  });

  for (const name of STANDALONE as (keyof typeof SERVES)[]) {
    it(`${name}.js in a plain script context equals dist analyze() on every fixture it reads and refuses the other family`, async () => {
      const analyze = standaloneWorker(name);
      const served = SERVES[name];
      for (const entry of fixtures) {
        const blob = await openAsBlob(join(FILES_DIR, entry.name));
        const family = familyOf(entry.container);
        const actual = await analyze(blob, entry.name);
        if (served === null || family === null || family === served) {
          expect(withoutTiming(actual), entry.name).toEqual(withoutTiming(JSON.parse(JSON.stringify(await dist.analyze(blob, { name: entry.name }))) as ProbeResult));
        } else {
          expect(actual, entry.name).toMatchObject({ name: entry.name, engine: 'own', container: family === 'isobmff' ? 'mp4' : 'matroska', error: WRONG[name], videoTracks: [] });
        }
      }
    });
  }
});
