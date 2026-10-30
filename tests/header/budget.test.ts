import { openAsBlob, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { isoBmffFixtureSet } from '../../scripts/compare/layout.ts';
import { analyzeHeader, type BlobLike, type HeaderLimits, type HeaderResult } from '../../src/header/index.ts';
import { FILES_DIR } from '../helpers/fixtures.ts';
import { box, bytes, ftyp, mdatHeader, moov, moovOfSize, recording, virtualSource, zeros, type Segment } from '../helpers/iso-builder.ts';

const MIB = 1024 * 1024;
const LIMIT_CODES = new Set(['byte-limit', 'read-limit', 'time-limit', 'structure-limit']);
const SWEEPS: Array<[keyof HeaderLimits, number[]]> = [
  ['maxBytes', [0, 15, 16, 1023, 1024, 4096, 65535, 65536, 262144, 2 * MIB]],
  ['maxReads', [0, 1, 2, 3, 4, 5]],
  ['maxTracks', [0, 1, 16]],
  ['maxTopLevelBoxes', [1, 4, 32]],
];

const UNLIMITED: HeaderLimits = { maxBytes: Number.POSITIVE_INFINITY, maxReads: Number.POSITIVE_INFINITY, maxMs: Number.POSITIVE_INFINITY, maxTracks: Number.POSITIVE_INFINITY, maxTopLevelBoxes: Number.POSITIVE_INFINITY };

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
    ['2000 free boxes', () => virtualSource(free)],
    ['20,000 trak boxes', () => virtualSource([ftyp(), box('moov', ...Array.from({ length: 20_000 }, () => box('trak'))), bytes(mdatHeader(8)), zeros(8)])],
  ];
}

const comparable = (r: HeaderResult): unknown => ({ ...r, io: null });

function check(label: string, r: HeaderResult, unlimited: HeaderResult, limits: HeaderLimits): void {
  if (limits.maxBytes !== undefined) expect(r.io.bytesRequested, label).toBeLessThanOrEqual(limits.maxBytes);
  if (limits.maxReads !== undefined) expect(r.io.reads, label).toBeLessThanOrEqual(limits.maxReads);
  if (r.errorCode && LIMIT_CODES.has(r.errorCode)) return;
  if (r.warnings.some((w) => w.startsWith('fragment index not read: limit reached: '))) {
    expect(r.videoTracks.every((t) => t.provenance.durationSec === 'estimated'), label).toBe(true);
    return;
  }
  expect(comparable(r), label).toEqual(comparable(unlimited));
}

async function sweep(label: string, open: () => BlobLike): Promise<number> {
  let runs = 0;
  const unlimited = await analyzeHeader(open(), { name: label, limits: UNLIMITED });
  for (const [key, values] of SWEEPS) {
    for (const value of values) {
      const limits = { ...UNLIMITED, [key]: value };
      const r = await analyzeHeader(open(), { name: label, limits });
      check(`${label} ${key} ${value}`, r, unlimited, { [key]: value });
      runs++;
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
    expect(runs).toBe(iso.length * 22);
  }, 300_000);

  test('every virtual source stays inside every swept limit and never rejects', async () => {
    for (const [label, open] of virtualSources()) await sweep(label, open);
  }, 300_000);

  test('the recommended tight server limits hold on every virtual source', async () => {
    const limits = { maxBytes: 2 * MIB, maxReads: 3, maxMs: 2500, maxTracks: 16, maxTopLevelBoxes: 32 };
    for (const [label, open] of virtualSources()) {
      const unlimited = await analyzeHeader(open(), { limits: UNLIMITED });
      check(label, await analyzeHeader(open(), { limits }), unlimited, limits);
    }
  }, 300_000);
});
