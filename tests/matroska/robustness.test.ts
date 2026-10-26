import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/core/analyze.ts';
import { CPU_MS_PER_BLOCK, estimateScan, planExactScan } from '../../src/core/matroska/index.ts';
import { parseBlock } from '../../src/core/matroska/scan.ts';
import { resolveOptions } from '../../src/core/options.ts';
import type { AnalyzeOptions, FileResult, Rational } from '../../src/core/types.ts';
import { FILES_DIR } from '../helpers/fixtures.ts';
import {
  blockBody,
  cfrClusters,
  cluster,
  concat,
  ebmlHeader,
  el,
  ID,
  info,
  segment,
  simpleBlock,
  str,
  trackEntry,
  tracks,
  uint,
} from './ebml-builder.ts';

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(join(FILES_DIR, name)));

function patched(name: string, edits: Array<[offset: number, bytes: number[]]>): Uint8Array {
  const b = fixture(name);
  for (const [o, bytes] of edits) b.set(bytes, o);
  return b;
}

function flipped(name: string, offset: number, bit: number): Uint8Array {
  const b = fixture(name);
  b[offset] ^= bit;
  return b;
}

function inserted(base: Uint8Array, at: number, bytes: Uint8Array): Uint8Array {
  return concat(base.subarray(0, at), bytes, base.subarray(at));
}

function garbage(n: number, seed: number): Uint8Array {
  let s = seed;
  return Uint8Array.from({ length: n }, () => {
    s = (s * 1103515245 + 12345) >>> 0;
    return Math.floor((s / 2 ** 32) * 256);
  });
}

async function run(bytes: Uint8Array | Blob, opts: AnalyzeOptions = {}): Promise<FileResult> {
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes.buffer as ArrayBuffer]);
  return analyze(blob, 'robustness.mkv', { matroskaMode: 'exact', ...opts });
}

const ratio = (r: Rational | null): string | null => (r ? `${r.num}/${r.den}` : null);
const warnings = (r: FileResult): string => [...r.warnings, ...r.videoTracks.flatMap((t) => t.warnings)].join(' | ');

describe('exact scan resynchronisation (frame counts equal ffprobe 8.1.1 nb_read_packets)', () => {
  it('drops only the rest of a Cluster after a corrupt BlockGroup size (h264_vfr_remux byte 6212 ^ 0x08)', async () => {
    const r = await run(flipped('h264_vfr_remux.mkv', 6212, 0x08));
    expect(r.videoTracks[0].frames).toBe(235);
    expect(ratio(r.videoTracks[0].avgFps)).toBe('235/6');
    expect(warnings(r)).toMatch(/skipped \d+ bytes of invalid data at 6213/);
    expect(warnings(r)).not.toMatch(/last Cluster or block ends beyond EOF/);
  });

  it('drops only the rest of a Cluster after a corrupt SimpleBlock size (vp9 byte 5841 ^ 0x08)', async () => {
    const r = await run(flipped('vp9.webm', 5841, 0x08));
    expect(r.videoTracks[0].frames).toBe(66);
    expect(warnings(r)).not.toMatch(/last Cluster or block ends beyond EOF/);
  });

  it('skips garbage between known-size Clusters and reads past the declared Segment end', async () => {
    const r = await run(inserted(fixture('vp9.webm'), 22975, garbage(300, 9)));
    expect(r.videoTracks[0].frames).toBe(90);
    expect(ratio(r.videoTracks[0].avgFps)).toBe('30000/1001');
    expect(warnings(r)).toMatch(/skipped 300 bytes of invalid data at 22975/);
    expect(warnings(r)).not.toMatch(/last Cluster or block ends beyond EOF/);
  });

  it('resynchronises from the last good element after garbage in an unknown-size Cluster', async () => {
    const r = await run(inserted(fixture('vp9_unknown_clusters.webm'), 22928, garbage(200, 2)));
    expect(r.videoTracks[0].frames).toBe(90);
    expect(warnings(r)).toMatch(/resynchronised at 23128/);
    expect(warnings(r)).not.toMatch(/last Cluster or block ends beyond EOF/);
  });

  it('drops a block that overruns its known-size Cluster together with the rest of that Cluster', async () => {
    const body = concat(uint(ID.Timestamp, 0), ...Array.from({ length: 10 }, (_, i) => simpleBlock({ track: 1, rel: i * 33 })));
    const short = el(ID.Cluster, body, 0, body.length - 20);
    const bytes = concat(ebmlHeader('matroska'), segment([info({ duration: 3000 }), tracks({ number: 1, defaultDuration: 33366666 }), short, ...cfrClusters({ frames: 30, periodMs: 33.3667 })]));
    const r = await run(bytes);
    expect(r.videoTracks[0].frames).toBe(39);
    expect(warnings(r)).not.toMatch(/last Cluster or block ends beyond EOF/);
  });

  it('caps the resynchronisation warnings', async () => {
    const clusters = Array.from({ length: 20 }, (_, i) => cluster(i * 80, [simpleBlock({ track: 1, rel: 0 }), simpleBlock({ track: 7, rel: 40 }), simpleBlock({ track: 1, rel: 40 })]));
    const r = await run(concat(ebmlHeader(), segment([info(), tracks({ number: 1, defaultDuration: 40_000_000 }), ...clusters])));
    expect(r.videoTracks[0].frames).toBe(20);
    expect(r.warnings.filter((w) => /bytes of invalid data/.test(w))).toHaveLength(5);
    expect(r.warnings).toContain('15 more resynchronisation(s) after invalid data');
  });
});

describe('block validation like ffmpeg', () => {
  it('treats a block with an unknown track number as Cluster corruption', async () => {
    const bytes = concat(
      ebmlHeader(),
      segment([info(), tracks({ number: 1, defaultDuration: 40_000_000 }), cluster(0, [0, 40, 80].map((rel) => simpleBlock({ track: rel === 40 ? 5 : 1, rel }))), cluster(120, [0, 40].map((rel) => simpleBlock({ track: 1, rel })))]),
    );
    const r = await run(bytes);
    expect(r.videoTracks[0].frames).toBe(3);
    expect(ratio(r.videoTracks[0].avgFps)).toBe('15/1');
  });

  it('rejects fixed, EBML and Xiph lacing that does not fit the block (vp9 first block)', async () => {
    expect((await run(patched('vp9.webm', [[428, [0x84]], [429, [0x03]]]))).videoTracks[0].frames).toBe(60);
    expect((await run(patched('vp9.webm', [[428, [0x86]], [429, [0xff]]]))).videoTracks[0].frames).toBe(60);
    expect((await run(patched('vp9.webm', [[428, [0x84]], [429, [0x01]]]))).videoTracks[0].frames).toBe(60);
    expect((await run(patched('vp9.webm', [[428, [0x82]], [429, [0x02]]]))).videoTracks[0].frames).toBe(92);
  });

  it('validates lace sizes and asks for more bytes when the lace header is not loaded', () => {
    const known = new Set([1]);
    const fixed = (laces: number, payload: number): Uint8Array => concat([0x81, 0, 0, 0x84, laces - 1], new Uint8Array(payload));
    expect(parseBlock(fixed(3, 30), 0, 35, known)).toMatchObject({ laces: 3 });
    expect(parseBlock(fixed(3, 31), 0, 36, known)).toBe('invalid');
    expect(parseBlock(fixed(3, 30), 0, 35, new Set([2]))).toBe('invalid');
    const xiph = concat([0x81, 0, 0, 0x82, 2, 0xff, 0x01, 10], new Uint8Array(300));
    expect(parseBlock(xiph, 0, xiph.length, known)).toMatchObject({ laces: 3 });
    expect(parseBlock(xiph, 0, 20, known)).toBe('invalid');
    expect(parseBlock(xiph.subarray(0, 6), 0, xiph.length, known)).toBe('more');
    const ebml = concat([0x81, 0, 0, 0x86, 3, 0x8a, 0xbf, 0xc0], new Uint8Array(60));
    expect(parseBlock(ebml, 0, ebml.length, known)).toMatchObject({ laces: 4 });
    expect(parseBlock(concat([0x81, 0, 0, 0x86, 3, 0x8a, 0x80, 0x80], new Uint8Array(60)), 0, 68, known)).toBe('invalid');
    expect(parseBlock(concat([0x81, 0, 0, 0x86, 1, 0x00]), 0, 6, known)).toBe('invalid');
  });

  it('drops a Cluster whose Timestamp is longer than 8 bytes', async () => {
    const bytes = concat(
      ebmlHeader('matroska'),
      segment([
        info({ duration: 3000 }),
        tracks({ number: 1, defaultDuration: 33366666 }),
        el(ID.Cluster, concat(el(ID.Timestamp, [0, 0, 0, 0, 0, 0, 0, 0, 5]), ...Array.from({ length: 10 }, (_, i) => simpleBlock({ track: 1, rel: i * 33 })))),
        cluster(330, Array.from({ length: 10 }, (_, i) => simpleBlock({ track: 1, rel: i * 33 }))),
      ]),
    );
    expect((await run(bytes)).videoTracks[0].frames).toBe(10);
  });

  it('drops a BlockGroup whose BlockDuration is longer than 8 bytes and the rest of its Cluster', async () => {
    const group = el(ID.BlockGroup, concat(el(ID.Block, blockBody({ track: 1, rel: 40, flags: 0 })), el(ID.BlockDuration, [0, 0, 0, 0, 0, 0, 0, 0, 40])));
    const bytes = concat(
      ebmlHeader(),
      segment([info(), tracks({ number: 1, defaultDuration: 40_000_000 }), cluster(0, [simpleBlock({ track: 1, rel: 0 }), group, simpleBlock({ track: 1, rel: 80 })]), cluster(120, [0, 40].map((rel) => simpleBlock({ track: 1, rel })))]),
    );
    expect((await run(bytes)).videoTracks[0].frames).toBe(3);
  });
});

describe('blocks before time 0 (ffmpeg leaves their PTS unset and libavformat interpolates it)', () => {
  it('back-fills a leading block from the next timestamp, so the stream stays CFR', async () => {
    const bytes = concat(
      ebmlHeader('matroska'),
      segment([info({ duration: 3000 }), tracks({ number: 1, defaultDuration: 33366666 }), cluster(0, [simpleBlock({ track: 1, rel: -100 }), ...Array.from({ length: 10 }, (_, i) => simpleBlock({ track: 1, rel: i * 33 }))])]),
    );
    const t = (await run(bytes)).videoTracks[0];
    expect(t.frames).toBe(11);
    expect(t.isVfr).toBe(false);
    expect(t.startSec).toBeCloseTo(-0.033, 12);
    expect(ratio(t.avgFps)).toBe('1000/33');
    expect(t.warnings.join(' ')).toMatch(/1 frame\(s\) before time 0/);
  });

  it('places a block in the middle of the stream after the previous frame', async () => {
    const bytes = concat(ebmlHeader(), segment([info(), tracks({ number: 1, defaultDuration: 33333333 }), cluster(0, [0, 33, -5, 100, 133].map((rel) => simpleBlock({ track: 1, rel })))]));
    const t = (await run(bytes)).videoTracks[0];
    expect(t.frames).toBe(5);
    expect(ratio(t.avgFps)).toBe('2500/83');
    expect(t.startSec).toBe(0);
  });
});

describe('Stage A header resynchronisation', () => {
  it('finds Info and Tracks after a SeekHead with an invalid size (vp9 byte 52 = 0x00)', async () => {
    const r = await run(patched('vp9.webm', [[52, [0x00]]]));
    expect(r.error).toBeNull();
    expect(r.videoTracks[0].frames).toBe(90);
    expect(r.warnings.join(' ')).toMatch(/invalid data at 48 before the first Cluster: resynchronised at 209/);
    const header = await run(patched('vp9.webm', [[52, [0x00]]]), { matroskaMode: 'header' });
    expect(header.videoTracks[0].avgFpsFfprobe).toBe('30000/1001');
    expect(header.io.reads).toBe(1);
  });

  it('recovers from a Void with a wrong size before Info (vp9 byte 120 ^ 0x04)', async () => {
    const r = await run(flipped('vp9.webm', 120, 0x04));
    expect(r.scan).toBe('exact');
    expect(r.videoTracks[0].frames).toBe(90);
  });

  it('reads level-1 elements when the Segment ID is damaged (vp9 byte 36 ^ 0x02)', async () => {
    const r = await run(flipped('vp9.webm', 36, 0x02));
    expect(r.videoTracks[0].frames).toBe(90);
    expect(r.warnings.join(' ')).toMatch(/no valid Segment header/);
  });

  it('treats a Segment size above 2^53 as corrupt and reads to the end of the file', async () => {
    const r = await run(patched('vp9.webm', [[40, [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe]]]));
    expect(r.videoTracks[0].frames).toBe(90);
    expect(r.formatDurationSec).toBe(3.003);
    expect(r.warnings.join(' ')).toMatch(/corrupt Segment size at 36/);
    expect(r.warnings.join(' ')).not.toMatch(/unknown size|truncated file/);
  });

  it('continues past a Segment size that is too small', async () => {
    const r = await run(patched('vp9.webm', [[40, [0x01, 0, 0, 0, 0, 0, 0, 100]]]));
    expect(r.videoTracks[0].frames).toBe(90);
    expect(r.warnings.join(' ')).toMatch(/Segment size is wrong/);
  });

  it('resynchronises after a level-1 element that claims to end beyond EOF (vp9_opus_live_audiotail byte 52 ^ 0x80)', async () => {
    const r = await run(flipped('vp9_opus_live_audiotail.webm', 52, 0x80));
    expect(r.videoTracks[0].frames).toBe(90);
    expect(r.warnings.join(' ')).toMatch(/114D9B74 at 48 ends after the end of the file: resynchronised at 209/);
  });
});

describe('concatenated Segments', () => {
  it('counts the blocks of a second Segment like ffprobe and says so', async () => {
    const vp9 = fixture('vp9.webm');
    const r = await run(concat(vp9, vp9));
    expect(r.videoTracks[0].frames).toBe(180);
    expect(r.warnings.join(' ')).toMatch(/data after the Segment end at 73687/);
    expect((await run(vp9)).warnings.join(' ')).not.toMatch(/after the Segment end/);
  });
});

describe('Tags and nesting', () => {
  it('assigns a DURATION tag whose Targets come after the SimpleTag', async () => {
    const tag = el(ID.Tag, concat(el(ID.SimpleTag, concat(str(ID.TagName, 'DURATION'), str(ID.TagString, '00:00:03.003000000'))), el(ID.Targets, uint(ID.TagTrackUID, 7))));
    const bytes = concat(ebmlHeader(), segment([info({ duration: 3003 }), tracks({ number: 1, uid: 7, defaultDuration: 33366666 }), el(ID.Tags, tag), ...cfrClusters({ frames: 3, periodMs: 33.3667 })]));
    const t = (await run(bytes, { matroskaMode: 'header' })).videoTracks[0];
    expect(t.durationSec).toBe(3.003);
    expect(t.provenance.durationSec).toBe('header');
  });

  it('ignores a DURATION SimpleTag nested inside another SimpleTag', async () => {
    const inner = el(ID.SimpleTag, concat(str(ID.TagName, 'DURATION'), str(ID.TagString, '00:00:09.000000000')));
    const tag = el(ID.Tag, concat(el(ID.Targets, uint(ID.TagTrackUID, 1)), el(ID.SimpleTag, concat(str(ID.TagName, 'ENCODER'), str(ID.TagString, 'x'), inner))));
    const bytes = concat(ebmlHeader(), segment([info(), tracks({ number: 1, defaultDuration: 40_000_000 }), el(ID.Tags, tag), ...cfrClusters({ frames: 3, periodMs: 40 })]));
    expect((await run(bytes, { matroskaMode: 'header' })).videoTracks[0].durationSec).toBeNull();
  });

  it('stops descending below 16 levels instead of overflowing the stack', async () => {
    let nested = concat(str(ID.TagName, 'X'), str(ID.TagString, 'y'));
    for (let i = 0; i < 3000; i++) nested = el(ID.SimpleTag, nested, 4);
    const bytes = concat(ebmlHeader(), segment([info({ duration: 3003 }), tracks({ number: 1, defaultDuration: 33366666 }), el(ID.Tags, el(ID.Tag, concat(el(ID.Targets, uint(ID.TagTrackUID, 1)), nested))), ...cfrClusters({ frames: 90, periodMs: 1000 / 29.97 })]));
    const r = await run(bytes);
    expect(r.error).toBeNull();
    expect(r.videoTracks[0].frames).toBe(90);
    expect(r.warnings.join(' ')).toMatch(/nested deeper than 16 levels/);
  });

  it('does not create tracks from TrackEntry elements outside Tracks', async () => {
    const stray = el(ID.Tags, el(ID.Tag, trackEntry({ number: 9, defaultDuration: 40_000_000 })));
    const bytes = concat(ebmlHeader(), segment([info(), tracks({ number: 1, defaultDuration: 40_000_000 }), stray, ...cfrClusters({ frames: 3, periodMs: 40 })]));
    expect((await run(bytes, { matroskaMode: 'header' })).videoTracks.map((t) => t.trackId)).toEqual([1]);
  });
});

describe('Stage A budget (5 reads, 1 MiB)', () => {
  it('keeps the Segment search within the budget', async () => {
    const voids = Array.from({ length: 20 }, () => el(ID.Void, new Uint8Array(100_000)));
    const r = await run(concat(ebmlHeader(), ...voids, segment([info(), tracks({ number: 1, defaultDuration: 33366666 }), ...cfrClusters({ frames: 3, periodMs: 33.3667 })])), { matroskaMode: 'header' });
    expect(r.error).toBe('no Segment element');
    expect(r.io.reads).toBeLessThanOrEqual(5);
    expect(r.io.bytesRead).toBeLessThanOrEqual(1024 * 1024);
  });

  it('reads a Tracks element with a 1.5 MiB CodecPrivate entry by entry', async () => {
    const entry = el(
      ID.TrackEntry,
      concat(uint(ID.TrackNumber, 1), uint(ID.TrackUID, 1), uint(ID.TrackType, 1), str(ID.CodecID, 'V_VP9'), el(0x63a2, new Uint8Array(1_500_000)), uint(ID.DefaultDuration, 33366666), el(ID.Video, concat(uint(ID.PixelWidth, 320), uint(ID.PixelHeight, 240)))),
    );
    const bytes = concat(ebmlHeader(), segment([info({ duration: 3000 }), el(ID.Tracks, entry), ...cfrClusters({ frames: 90, periodMs: 1000 / 29.97 })]));
    const r = await run(bytes, { matroskaMode: 'header' });
    expect(r.error).toBeNull();
    expect(r.videoTracks[0]).toMatchObject({ avgFpsFfprobe: '30000/1001', width: 320, height: 240 });
    expect(r.io.reads).toBeLessThanOrEqual(5);
    expect(r.io.bytesRead).toBeLessThanOrEqual(1024 * 1024);
    expect((await run(bytes)).videoTracks[0].frames).toBe(90);
  });

  it('walks many small cached level-1 elements without a hop limit', async () => {
    const voids = Array.from({ length: 100 }, () => el(ID.Void, [0]));
    const r = await run(concat(ebmlHeader(), segment([info({ duration: 3000 }), ...voids, tracks({ number: 1, defaultDuration: 33366666 }), ...cfrClusters({ frames: 90, periodMs: 1000 / 29.97 })])));
    expect(r.error).toBeNull();
    expect(r.videoTracks[0].frames).toBe(90);
  });
});

describe('Info Duration values', () => {
  it('keeps a negative Duration like ffprobe and rejects NaN with a clear message', async () => {
    const f64 = (v: number): number[] => {
      const a = new Uint8Array(8);
      new DataView(a.buffer).setFloat64(0, v);
      return [...a];
    };
    expect((await run(patched('vp9.webm', [[238, f64(-5000)]]), { matroskaMode: 'header' })).formatDurationSec).toBe(-5);
    const nan = await run(patched('vp9.webm', [[238, f64(NaN)]]), { matroskaMode: 'header' });
    expect(nan.formatDurationSec).toBeNull();
    expect(nan.warnings.join(' ')).toMatch(/invalid Duration value NaN/);
    expect(nan.warnings.join(' ')).not.toMatch(/invalid size/);
  });
});

describe('auto mode cost plan', () => {
  const cfrFile = (frames: number, payload: number, duration?: number): Uint8Array =>
    concat(ebmlHeader('matroska'), segment([info({ duration: duration ?? frames * 33.3667 }), tracks({ number: 1, defaultDuration: 33366666 }), ...cfrClusters({ frames, periodMs: 33.3667, payload })]));

  it('counts interleaved audio blocks and picks large windows for a 1 fps slideshow with Opus', async () => {
    const clusters = Array.from({ length: 180 }, (_, s) => cluster(s * 1000, [simpleBlock({ track: 1, rel: 0, payload: 8000 }), ...Array.from({ length: 50 }, (_, a) => simpleBlock({ track: 2, rel: a * 20, payload: 640 }))]));
    const bytes = concat(ebmlHeader('matroska'), segment([info({ duration: 180_000 }), tracks({ number: 1, defaultDuration: 1_000_000_000 }, { number: 2, type: 2, codecId: 'A_OPUS', defaultDuration: 20_000_000 }), ...clusters]));
    const r = await run(bytes, { matroskaMode: 'auto' });
    expect(r.scan).toBe('exact');
    expect(r.videoTracks[0].frames).toBe(180);
    expect(r.io.reads).toBeLessThanOrEqual(16);
  });

  it('does not trust a false 1 ms Duration when planning', async () => {
    const r = await run(cfrFile(20_000, 100, 1), { matroskaMode: 'auto' });
    expect(r.scan).toBe('exact');
    expect(r.videoTracks[0].frames).toBe(20_000);
    expect(r.io.reads).toBeLessThanOrEqual(8);
  });

  it('runs exact with 1 MiB windows when 4 KiB windows would exceed the budget (300 x 40 KB)', async () => {
    const r = await run(cfrFile(300, 40_000), { matroskaMode: 'auto' });
    expect(r.scan).toBe('exact');
    expect(r.io.reads).toBeLessThanOrEqual(20);
  });

  it('switches to large windows when small windows need far more reads than planned', async () => {
    const big = cluster(0, [simpleBlock({ track: 1, rel: 0, payload: 300_000 })]);
    const small = Array.from({ length: 267 }, (_, i) => cluster(34 + Math.floor(i * 30 * 33.3667), Array.from({ length: 30 }, (__, k) => simpleBlock({ track: 1, rel: Math.floor(k * 33.3667), payload: 1000 }))));
    const r = await run(concat(ebmlHeader('matroska'), segment([info(), tracks({ number: 1, defaultDuration: 33366666 }), big, ...small])));
    expect(r.videoTracks[0].frames).toBe(1 + 267 * 30);
    expect(r.io.reads).toBeLessThan(150);
  });

  it('says so when probe clusters hold one frame each instead of returning silent blanks', async () => {
    const bytes = concat(ebmlHeader('webm'), segment([info({ duration: 4000 }), tracks({ number: 1, defaultDuration: 40_000_000 }), ...cfrClusters({ frames: 100, periodMs: 40, perCluster: 1 })]));
    const r = await run(bytes, { matroskaMode: 'probe' });
    expect(r.scan).toBe('probe');
    expect(r.videoTracks[0].isVfr).toBeNull();
    expect(warnings(r)).toMatch(/fewer than 2 frames of this track/);
    const exact = await run(bytes);
    expect(exact.videoTracks[0].isVfr).toBe(false);
  });

  it('skips a large Attachments element (fonts, cover art) without a raw EBML ID warning', async () => {
    const attachments = el(0x1941a469, new Uint8Array(3_000_000));
    const bytes = concat(ebmlHeader('matroska'), segment([info(), tracks({ number: 1, defaultDuration: 40_000_000 }), attachments, ...cfrClusters({ frames: 50, periodMs: 40 })]));
    const r = await run(bytes);
    expect(r.error).toBeNull();
    expect(r.videoTracks[0].frames).toBe(50);
    expect(warnings(r)).not.toMatch(/1941A469|header budget/i);
  });

  it('prices laced frames, not blocks, so a small laced file cannot force a huge exact scan in auto mode', async () => {
    const blocks = Array.from({ length: 50 }, (_, c) =>
      cluster(c * 256 * 100, Array.from({ length: 100 }, (__, k) => simpleBlock({ track: 1, rel: k * 256, laces: 256, payload: 256 }))),
    );
    const bytes = concat(ebmlHeader('webm'), segment([info({ duration: 1000 }), tracks({ number: 1, defaultDuration: 1_000_000 }), ...blocks]));
    expect(bytes.length).toBeLessThan(3_000_000);
    const auto = await run(bytes, { matroskaMode: 'auto' });
    expect(auto.scan).toBe('probe');
    expect(warnings(auto)).toMatch(/exact block scan skipped: predicted \d+ ms/);
    const capped = await run(bytes, { maxExpandedSamples: 100_000 });
    expect(capped.scan).toBe('exact');
    expect(capped.videoTracks[0].frames).toBe(50 * 100 * 256);
    expect(warnings(capped)).toMatch(/per-frame statistics skipped: more than 100000 frames/);
  });

  it('adds a per-block CPU term and estimates blocks from the sampled density', () => {
    const opts = resolveOptions();
    const region = 14_457_930;
    const plan = planExactScan(region, { blocks: 648_000, large: 0, smallBytes: region }, opts);
    expect(plan.window).toBe(1024 * 1024);
    expect(plan.ms).toBeCloseTo(Math.ceil(region / (1024 * 1024)) * 0.8 + region / 500_000 + 648_000 * CPU_MS_PER_BLOCK, 6);
    expect(plan.ms).toBeGreaterThan(opts.exactBudgetMs);
    const sampled = { bytes: 16_000, blocks: 700, video: 700, large: 0, smallBytes: 16_000 };
    expect(estimateScan(region, sampled, 0.03)?.blocks).toBeCloseTo((700 * region) / 16_000, 6);
    expect(estimateScan(region, sampled, 1_000_000)?.blocks).toBeCloseTo(1_000_000, 6);
    expect(estimateScan(region, null, 0)).toBeNull();
  });
});

describe('strings from the file in warnings', () => {
  it('replace NUL and other control characters, so a warning stays printable', async () => {
    const bytes = concat(ebmlHeader('web\u0001m'), segment([info(), tracks({ number: 1, codecId: 'V_\u0007X' }), ...cfrClusters({ frames: 30, periodMs: 40 })]));
    const r = await run(bytes, { matroskaMode: 'auto' });
    expect(warnings(r)).toMatch(/unexpected DocType 'web\?m'/);
    expect(warnings(r)).toMatch(/V_\?X/);
    expect(warnings(r).split(' | ').filter((w) => /[^\x20-\x7e\xa0-\uffff]/.test(w))).toEqual([]);
  });
});

