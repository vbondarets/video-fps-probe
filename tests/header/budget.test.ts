import { openAsBlob, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { isoBmffFixtureSet } from '../../scripts/compare/layout.ts';
import { analyzeHeader, warningCodesOf, type BlobLike, type HeaderLimits, type HeaderResult } from '../../src/header/index.ts';
import { FILES_DIR } from '../helpers/fixtures.ts';
import { auxiliary, box, bytes, ftyp, mdatHeader, moof, moov, moovOfSize, mvex, recording, sidx, videoSidxOnly, virtualSource, withText, zeros, type Segment, type VirtualSource } from '../helpers/iso-builder.ts';

const MIB = 1024 * 1024;
const LIMIT_CODES = new Set(['byte-limit', 'read-limit', 'time-limit', 'structure-limit']);
const SWEEPS: Array<[keyof HeaderLimits, number[]]> = [
  ['maxBytes', [0, 15, 16, 1023, 1024, 4096, 65535, 65536, 262144, 2 * MIB]],
  ['maxReads', [0, 1, 2, 3, 4, 5]],
  ['maxTracks', [0, 1, 16]],
  ['maxTopLevelBoxes', [1, 4, 32]],
];

const UNLIMITED: HeaderLimits = { maxBytes: Number.POSITIVE_INFINITY, maxReads: Number.POSITIVE_INFINITY, maxMs: Number.POSITIVE_INFINITY, maxTracks: Number.POSITIVE_INFINITY, maxTopLevelBoxes: Number.POSITIVE_INFINITY };
const HEADS = [undefined, 1024];

function singleSound(): VirtualSource {
  const head = bytes(ftyp('cmfc'), moov([{ id: 1, handler: 'soun', timescale: 48000 }], [mvex({ trex: [{ id: 1, duration: 1024 }] })]));
  const m = moof(1, [{ id: 1, baseDts: 0, count: 470, duration: 1024 }], 20_000);
  const pad = 65_536 - 40 - head.length - sidx(1, 48000, 0, [[0, 0]]).length;
  return virtualSource([head, sidx(1, 48000, 0, [[m.length + 8 + 20_000, 469 * 1024]], pad), box('free', zeros(pad - 8)), m, mdatHeader(20_000), { zeros: 20_000 }]);
}

function slow(open: () => BlobLike, ms: number): () => BlobLike {
  return () => {
    const inner = open();
    return { size: inner.size, slice: (start, end) => ({ arrayBuffer: () => new Promise<ArrayBuffer>((resolve, reject) => setTimeout(() => inner.slice(start, end).arrayBuffer().then(resolve, reject), ms)) }) };
  };
}

function virtualSources(): Array<[string, () => BlobLike]> {
  const video = { id: 1, samples: [[90, 512]] as Array<[number, number]> };
  const free: Segment[] = [ftyp()];
  for (let i = 0; i < 2000; i++) free.push(box('free', zeros(8)));
  free.push(moov([video]));
  const big = moovOfSize(2_614_543, { id: 1 });
  return [
    ['moov at the end of 13 MB', () => virtualSource([ftyp(), mdatHeader(10 * MIB), { zeros: 10 * MIB }, big])],
    ['100 KiB faststart moov', () => virtualSource([ftyp(), moovOfSize(100 * 1024, { id: 1 }), mdatHeader(64 * MIB), { zeros: 64 * MIB }])],
    ['1800 fragments without an index', () => recording({ fragments: 1800, mdatBytes: 100, index: false }).source],
    ['recording with an mfra', () => recording({ fragments: 6, mdatBytes: MIB }).source],
    ['recording with longer audio', () => recording({ fragments: 4, mdatBytes: MIB, audio: true, audioLonger: 20 }).source],
    ['recording with mehd and an mfra', () => recording({ fragments: 4, mdatBytes: MIB, mehd: 4000 }).source],
    ['sidx after the moov', () => recording({ fragments: 3, mdatBytes: 1000, index: false, sidx: true }).source],
    ['40 free boxes between the moov and the first moof, with mehd', () => recording({ fragments: 3, mdatBytes: 1000, mehd: 3000, free: Array.from({ length: 40 }, () => box('free')) }).source],
    ['a 70 KiB free box between the moov and the first moof', () => recording({ fragments: 3, mdatBytes: 1000, free: [box('free', zeros(70 * 1024))] }).source],
    ['a single moof with longer audio', () => recording({ fragments: 1, mdatBytes: MIB, audio: true, audioLonger: 7 }).source],
    ['composition offsets with a sidx per fragment', () => recording({ fragments: 4, mdatBytes: 100_000, cts: 1024, sidx: 'fragment' }).source],
    ['40 free boxes after a moov without mvex', () => virtualSource([ftyp(), moov([video]), ...Array.from({ length: 40 }, () => box('free')), mdatHeader(MIB), { zeros: MIB }])],
    ['2000 free boxes', () => virtualSource(free)],
    ['20,000 trak boxes', () => virtualSource([ftyp(), box('moov', ...Array.from({ length: 20_000 }, () => box('trak'))), bytes(mdatHeader(8)), zeros(8)])],
    ['one sound fragment across the head window with a sidx to the end and no mfra', singleSound],
    ['a video sidx with shorter sound found through the mfra', () => recording({ fragments: 4, mdatBytes: 100_000, audio: true, audioShorter: 10, sidx: true }).source],
    ['a text track in the first of three moofs that ends 0.5 s after the video', () => withText(3, 3500)],
    ['a text track indexed in the mfra beside B-frame video, sound and mehd', () => auxiliary(6000, true)],
    ['a sidx for the video only beside sound, without an mfra', () => videoSidxOnly(3)],
    ['a sidx for the video only beside sound, with an mfra', () => videoSidxOnly(3, true)],
  ];
}

const comparable = (r: HeaderResult): unknown => ({ ...r, io: null });

function check(label: string, r: HeaderResult, unlimited: HeaderResult, limits: HeaderLimits): void {
  if (limits.maxBytes !== undefined) expect(r.io.bytesRequested, label).toBeLessThanOrEqual(limits.maxBytes);
  if (limits.maxReads !== undefined) expect(r.io.reads, label).toBeLessThanOrEqual(limits.maxReads);
  if (r.errorCode && LIMIT_CODES.has(r.errorCode)) {
    if (r.videoTracks.length > 0) expect(r.videoTracks.map((t) => t.trackId), label).toEqual(unlimited.videoTracks.map((t) => t.trackId));
    return;
  }
  if (r.warnings.includes('too many top-level boxes')) {
    expect({ ...comparable(r) as object, warnings: null }, label).toEqual({ ...comparable(unlimited) as object, warnings: null });
    return;
  }
  if (warningCodesOf(r).includes('fragment-index-unread')) {
    expect(r.videoTracks.map((t) => t.trackId), label).toEqual(unlimited.videoTracks.map((t) => t.trackId));
    r.videoTracks.forEach((t, i) => {
      if (t.durationSec !== null && t.provenance.durationSec !== 'estimated') expect(t.durationSec, `${label} track ${t.trackId}`).toBe(unlimited.videoTracks[i].durationSec);
    });
    return;
  }
  expect(comparable(r), label).toEqual(comparable(unlimited));
}

async function sweep(label: string, open: () => BlobLike): Promise<number> {
  let runs = 0;
  for (const head of HEADS) {
    const readAhead = { head };
    const unlimited = await analyzeHeader(open(), { name: label, limits: UNLIMITED, readAhead });
    for (const [key, values] of SWEEPS) {
      for (const value of values) {
        const limits = { ...UNLIMITED, [key]: value };
        const r = await analyzeHeader(open(), { name: label, limits, readAhead });
        check(`${label} head ${head ?? 'default'} ${key} ${value}`, r, unlimited, { [key]: value });
        runs++;
      }
    }
  }
  return runs;
}

describe('budget sweep', () => {
  test('every committed ISO BMFF fixture stays inside every swept limit and never rejects', async () => {
    const names = readdirSync(FILES_DIR).sort();
    const iso = await isoBmffFixtureSet(names, (n) => join(FILES_DIR, n));
    expect(iso.length).toBeGreaterThan(100);
    let runs = 0;
    for (const name of iso) {
      const blob = await openAsBlob(join(FILES_DIR, name));
      runs += await sweep(name, () => blob);
    }
    expect(runs).toBe(iso.length * 22 * HEADS.length);
  }, 300_000);

  test('every virtual source stays inside every swept limit and never rejects', async () => {
    for (const [label, open] of virtualSources()) await sweep(label, open);
  }, 300_000);

  test('the recommended tight server limits hold on every virtual source', async () => {
    const limits = { maxBytes: 2 * MIB, maxReads: 3, maxMs: 2500, maxTracks: 16, maxTopLevelBoxes: 32 };
    for (const [label, open] of virtualSources()) {
      for (const head of HEADS) {
        const unlimited = await analyzeHeader(open(), { limits: UNLIMITED, readAhead: { head } });
        check(`${label} head ${head ?? 'default'}`, await analyzeHeader(open(), { limits, readAhead: { head } }), unlimited, limits);
      }
    }
  }, 300_000);

  test('a slow source under maxMs equals the unlimited result or carries a limit code', async () => {
    const sources = virtualSources().filter(([label]) => /sound fragment across|video sidx with shorter sound|text track in the first/.test(label));
    expect(sources.length).toBe(3);
    for (const [label, open] of sources) {
      const source = slow(open, 40);
      const unlimited = await analyzeHeader(source(), { limits: UNLIMITED });
      for (const maxMs of [0, 30, 70, 110, 150]) check(`${label} maxMs ${maxMs}`, await analyzeHeader(source(), { limits: { ...UNLIMITED, maxMs } }), unlimited, {});
    }
  }, 60_000);
});
