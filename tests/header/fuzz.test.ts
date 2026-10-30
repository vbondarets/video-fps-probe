import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import type { BoxHeader } from '../../src/core/isobmff/boxes.ts';
import { analyzeHeader, type BlobLike, type HeaderResult } from '../../src/header/index.ts';
import { FILES_DIR } from '../helpers/fixtures.ts';
import { box, ftyp, mdatHeader, recording, zeros } from '../helpers/iso-builder.ts';

const visited = vi.hoisted(() => ({ trak: 0 }));

vi.mock('../../src/core/isobmff/boxes.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/core/isobmff/boxes.ts')>();
  return {
    ...original,
    readBoxHeader: (...args: Parameters<typeof original.readBoxHeader>): BoxHeader | null => {
      const h = original.readBoxHeader(...args);
      if (h?.type === 'trak') visited.trak++;
      return h;
    },
  };
});

const CASES = 10_000;
const SEEDS = ['cfr_h264_30.mp4', 'fmp4_global_sidx.mp4', 'fmp4_audio_longer.mp4', 'edge_single_frame.mp4', 'rec_chromium_h264.mp4', 'fmp4_mehd_valid.mp4', 'av_h264_aac_faststart.mp4', 'mov_cmov.mov'];
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'mvex', 'moof', 'traf', 'mfra', 'dinf', 'udta']);
const TYPES = ['moov', 'trak', 'moof', 'mdat', 'sidx', 'mfra', 'tfra', 'free', 'mvex', 'mehd', 'stsd', 'mfro'];
const TIGHT = { maxBytes: 2 * 1024 * 1024, maxReads: 3, maxMs: 2500, maxTracks: 16, maxTopLevelBoxes: 32 };

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function boxStarts(buf: Uint8Array): number[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out: number[] = [];
  const walk = (start: number, end: number, depth: number): void => {
    let p = start;
    while (p + 8 <= end && out.length < 4000) {
      const size = dv.getUint32(p);
      const type = String.fromCharCode(buf[p + 4], buf[p + 5], buf[p + 6], buf[p + 7]);
      if (size < 8 || p + size > end) return;
      out.push(p);
      if (CONTAINERS.has(type) && depth < 8) walk(p + 8, p + size, depth + 1);
      p += size;
    }
  };
  walk(0, buf.length, 0);
  return out;
}

function source(buf: Uint8Array): BlobLike {
  return { size: buf.length, slice: (s = 0, e = buf.length) => ({ arrayBuffer: async () => buf.slice(s, e).buffer }) };
}

function mutate(seed: Uint8Array, starts: number[], next: () => number): Uint8Array {
  let buf: Uint8Array = seed.slice();
  const pick = (n: number): number => Math.floor(next() * n);
  const edits = 1 + pick(4);
  for (let i = 0; i < edits; i++) {
    const kind = pick(6);
    const at = starts[pick(starts.length)] ?? 0;
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (kind === 0 && at + 4 <= buf.length) dv.setUint32(at, [0, 1, 7, 8, 9, 0xffffffff, pick(2 ** 32), buf.length - at + 1][pick(8)]);
    else if (kind === 1 && at + 8 <= buf.length) buf.set([...TYPES[pick(TYPES.length)]].map((c) => c.charCodeAt(0)), at + 4);
    else if (kind === 2) buf[pick(buf.length)] ^= 1 << pick(8);
    else if (kind === 3) buf = buf.slice(0, Math.max(1, pick(buf.length)));
    else if (kind === 4 && at + 16 <= buf.length) for (let k = 8; k < 16; k++) buf[at + k] = pick(256);
    else if (kind === 5 && at + 12 <= buf.length) dv.setUint32(at + 8, [0, 1, 0xffffffff, pick(2 ** 32)][pick(4)]);
  }
  return buf;
}

describe('hostile input', () => {
  test(`${CASES} seeded mutations never reject and every error is coded`, async () => {
    const seeds = SEEDS.map((name) => new Uint8Array(readFileSync(join(FILES_DIR, name))));
    const rec = recording({ fragments: 5, mdatBytes: 5000, audio: true, mehd: 5000 }).source;
    seeds.push(new Uint8Array(await rec.slice(0, rec.size).arrayBuffer()));
    const starts = seeds.map(boxStarts);
    const next = rng(0x5eed);
    const codes = new Map<string, number>();
    const internal: string[] = [];
    const t0 = performance.now();
    for (let i = 0; i < CASES; i++) {
      const k = Math.floor(next() * seeds.length);
      const buf = mutate(seeds[k], starts[k], next);
      let r: HeaderResult;
      try {
        r = await analyzeHeader(source(buf), { limits: i % 2 === 0 ? undefined : TIGHT, fragmentedDuration: i % 5 === 0 ? 'header' : 'index' });
      } catch (e) {
        throw new Error(`case ${i} from ${SEEDS[k] ?? 'recording'} rejected: ${String(e)}`);
      }
      expect(r.error === null, `case ${i}`).toBe(r.errorCode === null);
      if (r.errorCode === 'internal') internal.push(`case ${i} from ${SEEDS[k] ?? 'recording'}: ${r.error}`);
      if (r.errorCode) codes.set(r.errorCode, (codes.get(r.errorCode) ?? 0) + 1);
      expect(r.io.bytesRequested).toBeLessThanOrEqual(i % 2 === 0 ? 16 * 1024 * 1024 : TIGHT.maxBytes);
    }
    console.log(`fuzz: ${CASES} cases in ${Math.round(performance.now() - t0)} ms, codes ${JSON.stringify(Object.fromEntries([...codes].sort()))}`);
    expect(internal).toEqual([]);
  }, 600_000);

  test('a moov of 20,000 minimal trak boxes stops with structure-limit after at most maxTracks + 1 trak headers', async () => {
    const many = box('moov', ...Array.from({ length: 20_000 }, () => box('trak')));
    const buf = new Uint8Array([...ftyp(), ...many, ...mdatHeader(8), ...zeros(8)]);
    for (const maxTracks of [0, 16, 64]) {
      visited.trak = 0;
      const r = await analyzeHeader(source(buf), { limits: { maxTracks } });
      expect(r).toMatchObject({ errorCode: 'structure-limit', error: `limit reached: maxTracks ${maxTracks}`, videoTracks: [] });
      expect(visited.trak).toBeGreaterThan(0);
      expect(visited.trak).toBeLessThanOrEqual(maxTracks + 1);
    }
  });
});
