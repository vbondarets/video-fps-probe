import { describe, expect, test } from 'vitest';
import { analyze } from '../../src/core/analyze.ts';
import { analyzeIsoBmff } from '../../src/core/isobmff/index.ts';
import { resolveOptions } from '../../src/core/options.ts';
import { BlobReader } from '../../src/core/reader.ts';
import { boundEntries, childBoxes, IsoBmffError, readBoxHeader } from '../../src/core/isobmff/boxes.ts';
import { codecNameFor, isVideoFourcc } from '../../src/core/isobmff/codecs.ts';
import { newMovie, newTrack, type IsoTrack } from '../../src/core/isobmff/model.ts';
import { parseTfhd, parseTrun, trunRecordSize, type Tfhd } from '../../src/core/isobmff/moof.ts';
import { parseStts } from '../../src/core/isobmff/moov.ts';
import { PREFETCH_BATCH, parseTfraOffsets } from '../../src/core/isobmff/prefetch.ts';
import { displayRotation, ffprobeStage1Rate, rescaleRound } from '../../src/core/isobmff/track.ts';
import { primaryTrack } from '../../src/core/result.ts';
import type { FileResult } from '../../src/core/types.ts';

type Bytes = Uint8Array<ArrayBuffer>;
type Part = Uint8Array | number[];

function bytes(...parts: Part[]): Bytes {
  const arrays = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrays) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

function u16(n: number): number[] {
  return [(n >>> 8) & 255, n & 255];
}

function u32(n: number): number[] {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}

function u64(n: bigint): number[] {
  return [...u32(Number(n >> 32n)), ...u32(Number(n & 0xffffffffn))];
}

function tag(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}

function zeros(n: number): number[] {
  return new Array<number>(n).fill(0);
}

function box(type: string, ...parts: Part[]): Bytes {
  const body = bytes(...parts);
  return bytes(u32(body.length + 8), tag(type), body);
}

function fullBox(type: string, version: number, flags: number, ...parts: Part[]): Bytes {
  return box(type, [version, (flags >>> 16) & 255, (flags >>> 8) & 255, flags & 255], ...parts);
}

function view(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

const IDENTITY = [65536, 0, 0, 0, 65536, 0, 0, 0, 1 << 30];
const ROT90 = [0, 65536, 0, -65536, 0, 0, 0, 0, 1 << 30];

function matrix(m: number[]): number[] {
  return m.flatMap((v) => u32(v >>> 0));
}

function ftyp(brand = 'isom'): Bytes {
  return box('ftyp', tag(brand), u32(512), tag(brand), tag('mp41'));
}

function mvhd(ts: number, dur: number, m = IDENTITY): Bytes {
  return fullBox('mvhd', 0, 0, u32(0), u32(0), u32(ts), u32(dur), u32(0x10000), u16(0x100), zeros(10), matrix(m), zeros(24), u32(9));
}

function tkhd(id: number, flags = 3, m = IDENTITY): Bytes {
  return fullBox('tkhd', 0, flags, u32(0), u32(0), u32(id), u32(0), u32(0), zeros(8), u16(0), u16(0), u16(0), u16(0), matrix(m), u32(160 << 16), u32(90 << 16));
}

function mdhd(ts: number, dur: number): Bytes {
  return fullBox('mdhd', 0, 0, u32(0), u32(0), u32(ts), u32(dur), u16(0x55c4), u16(0));
}

function hdlr(type: string): Bytes {
  return fullBox('hdlr', 0, 0, u32(0), tag(type), zeros(12), [0]);
}

function visualEntry(fourcc: string, w = 160, h = 90, ...children: Uint8Array[]): Bytes {
  return box(fourcc, zeros(6), u16(1), zeros(16), u16(w), u16(h), u32(0x480000), u32(0x480000), u32(0), u16(1), zeros(32), u16(24), u16(0xffff), ...children);
}

function stsd(entry: Uint8Array): Bytes {
  return fullBox('stsd', 0, 0, u32(1), entry);
}

function stts(entries: Array<[number, number]>, declared = entries.length): Bytes {
  return fullBox('stts', 0, 0, u32(declared), entries.flatMap(([c, d]) => [...u32(c), ...u32(d)]));
}

function ctts(entries: Array<[number, number]>): Bytes {
  return fullBox('ctts', 0, 0, u32(entries.length), entries.flatMap(([c, o]) => [...u32(c), ...u32(o >>> 0)]));
}

function stss(numbers: number[]): Bytes {
  return fullBox('stss', 0, 0, u32(numbers.length), numbers.flatMap((n) => u32(n)));
}

function sampleTables(count: number, chunkOffset: number, sampleSize = 10): Uint8Array[] {
  if (count === 0) return [fullBox('stsz', 0, 0, u32(0), u32(0)), fullBox('stsc', 0, 0, u32(0)), fullBox('stco', 0, 0, u32(0))];
  return [
    fullBox('stsz', 0, 0, u32(sampleSize), u32(count)),
    fullBox('stsc', 0, 0, u32(1), u32(1), u32(count), u32(1)),
    fullBox('stco', 0, 0, u32(1), u32(chunkOffset)),
  ];
}

function elst(entries: Array<[number, number]>): Bytes {
  return box('edts', fullBox('elst', 0, 0, u32(entries.length), entries.flatMap(([d, t]) => [...u32(d), ...u32(t >>> 0), ...u32(0x10000)])));
}

interface TrakSpec {
  id: number;
  handler?: string;
  entry?: Uint8Array;
  ts?: number;
  stts?: Array<[number, number]>;
  sttsDeclared?: number;
  ctts?: Array<[number, number]>;
  sync?: number[];
  edits?: Array<[number, number]>;
  flags?: number;
  matrix?: number[];
  chunkOffset?: number;
  sampleSize?: number;
  sampleCount?: number;
  tables?: Uint8Array[];
  mdhdDuration?: number;
  extra?: Uint8Array[];
  trackHeader?: Uint8Array;
  mediaHeader?: Uint8Array;
}

function trak(spec: TrakSpec): Bytes {
  const ts = spec.ts ?? 15360;
  const entries = spec.stts ?? [];
  const count = entries.reduce((n, [c]) => n + c, 0);
  const dur = entries.reduce((n, [c, d]) => n + c * d, 0);
  const tables = [
    stsd(spec.entry ?? visualEntry('avc1')),
    stts(entries, spec.sttsDeclared),
    ...(spec.ctts ? [ctts(spec.ctts)] : []),
    ...(spec.sync ? [stss(spec.sync)] : []),
    ...(spec.tables ?? sampleTables(spec.sampleCount ?? count, spec.chunkOffset ?? 0, spec.sampleSize)),
  ];
  return box(
    'trak',
    spec.trackHeader ?? tkhd(spec.id, spec.flags ?? 3, spec.matrix),
    ...(spec.edits ? [elst(spec.edits)] : []),
    ...(spec.extra ?? []),
    box('mdia', spec.mediaHeader ?? mdhd(ts, spec.mdhdDuration ?? dur), hdlr(spec.handler ?? 'vide'), box('minf', box('stbl', ...tables))),
  );
}

function moov(...children: Uint8Array[]): Bytes {
  return box('moov', mvhd(1000, 3000), ...children);
}

function mvex(trexDuration: number | null, trackId = 1): Bytes {
  return box('mvex', ...(trexDuration === null ? [] : [fullBox('trex', 0, 0, u32(trackId), u32(1), u32(trexDuration), u32(0), u32(0))]));
}

function moof(seq: number, trafs: Uint8Array[]): Bytes {
  return box('moof', fullBox('mfhd', 0, 0, u32(seq)), ...trafs);
}

function traf(tfhdFlags: number, tfhdFields: number[], tfdt: number | null, trun: Uint8Array): Bytes {
  return box('traf', fullBox('tfhd', 0, tfhdFlags, u32(1), tfhdFields), ...(tfdt === null ? [] : [fullBox('tfdt', 1, 0, u64(BigInt(tfdt)))]), trun);
}

function trun(version: number, flags: number, count: number, fields: number[]): Bytes {
  return fullBox('trun', version, flags, u32(count), fields);
}

async function run(file: Bytes, opts: Parameters<typeof analyze>[2] = {}): Promise<FileResult> {
  return analyze(new Blob([file]), 'synthetic.mp4', opts);
}

const CFR30 = (n = 90): TrakSpec => ({ id: 1, stts: [[n, 512]] });

describe('box header', () => {
  test('plain 32-bit size', () => {
    const b = box('free', zeros(8));
    expect(readBoxHeader(view(b), 0, b.length)).toEqual({ type: 'free', start: 0, size: 16, headerSize: 8, end: 16, truncated: false });
  });

  test('size 0 runs to the end of the parent', () => {
    const b = bytes(u32(0), tag('mdat'), zeros(100));
    expect(readBoxHeader(view(b), 0, b.length)).toMatchObject({ size: 108, end: 108, truncated: false });
    expect(readBoxHeader(view(b), 0, 60)).toMatchObject({ size: 60, end: 60 });
  });

  test('size 1 reads a 64-bit largesize', () => {
    const b = bytes(u32(1), tag('mdat'), u64(2n ** 40n), zeros(16));
    const h = readBoxHeader(view(b), 0, 2 ** 41);
    expect(h).toMatchObject({ type: 'mdat', size: 2 ** 40, headerSize: 16, end: 2 ** 40, truncated: false });
    expect(readBoxHeader(view(b), 0, b.length)).toMatchObject({ truncated: true, end: b.length });
  });

  test('largesize above 2^53-1 is rejected', () => {
    const b = bytes(u32(1), tag('mdat'), u64(2n ** 53n), zeros(8));
    expect(() => readBoxHeader(view(b), 0, b.length)).toThrow(IsoBmffError);
    expect(() => readBoxHeader(view(b), 0, b.length)).toThrow(/2\^53-1/);
  });

  test('uuid adds 16 bytes to the header', () => {
    const b = bytes(u32(40), tag('uuid'), zeros(32));
    expect(readBoxHeader(view(b), 0, b.length)).toMatchObject({ headerSize: 24, size: 40 });
    const large = bytes(u32(1), tag('uuid'), u64(48n), zeros(32));
    expect(readBoxHeader(view(large), 0, large.length)).toMatchObject({ headerSize: 32, size: 48 });
  });

  test('size smaller than the header is corrupt', () => {
    expect(() => readBoxHeader(view(bytes(u32(7), tag('free'))), 0, 8)).toThrow(/smaller than its header/);
    expect(() => readBoxHeader(view(bytes(u32(20), tag('uuid'), zeros(16))), 0, 24)).toThrow(/smaller than its header/);
    expect(() => readBoxHeader(view(bytes(u32(1), tag('mdat'), u64(12n))), 0, 16)).toThrow(/smaller than its header/);
  });

  test('missing header bytes give null instead of a guess', () => {
    expect(readBoxHeader(view(bytes(u32(16), tag('fr'))), 0, 6)).toBeNull();
    expect(readBoxHeader(view(bytes(u32(1), tag('mdat'), u32(0))), 0, 12)).toBeNull();
  });

  test('child walk stops at a zero terminator and at an invalid child', () => {
    const container = bytes(box('free'), box('skip', zeros(4)), u32(0));
    expect([...childBoxes(view(container), 0, container.length)].map((h) => h.type)).toEqual(['free', 'skip']);
    const warnings: string[] = [];
    const broken = bytes(box('free'), u32(3), tag('junk'), box('skip'));
    expect([...childBoxes(view(broken), 0, broken.length, warnings)].map((h) => h.type)).toEqual(['free']);
    expect(warnings[0]).toMatch(/ignored invalid child/);
  });
});

describe('entry bounding', () => {
  test('a count larger than the box is clamped with a warning', () => {
    const warnings: string[] = [];
    expect(boundEntries(2147483647, 16, 8, 'stts', warnings)).toBe(2);
    expect(warnings).toEqual(['stts declares 2147483647 entries but its box holds only 2']);
    expect(boundEntries(2, 16, 8, 'stts', warnings)).toBe(2);
    expect(warnings).toHaveLength(1);
  });

  test('stts deltas above max_stts_delta are clipped to 1 like ffprobe', () => {
    const tr = newTrack();
    const b = stts([
      [10, 1000],
      [1, 0xfffffff0],
      [5, 1000],
    ]);
    parseStts(view(b), readBoxHeader(view(b), 0, b.length)!, tr);
    expect(Array.from(tr.sttsDeltas)).toEqual([1000, 1, 997]);
    expect(tr.warnings[0]).toMatch(/clipped to 1/);
  });
});

describe('trun and tfhd', () => {
  test('trun record size is 4 bytes per per-sample flag', () => {
    expect(trunRecordSize(0)).toBe(0);
    expect(trunRecordSize(0x001 | 0x004)).toBe(0);
    expect(trunRecordSize(0x100)).toBe(4);
    expect(trunRecordSize(0x300)).toBe(8);
    expect(trunRecordSize(0xf05)).toBe(16);
    expect(trunRecordSize(0x800)).toBe(4);
  });

  function tfhdOf(flags: number, fields: number[], trex: boolean): Tfhd | null {
    const movie = newMovie(1e6);
    if (trex) movie.trex.set(1, { duration: 333, size: 44 });
    const b = fullBox('tfhd', 0, flags, u32(1), fields);
    return parseTfhd(view(b), 8, b.length, movie, 5000, 7000);
  }

  test('tfhd optional fields in order, with trex fallbacks', () => {
    expect(tfhdOf(0, [], true)).toEqual({ flags: 0, trackId: 1, baseDataOffset: 7000, defaultDuration: 333, defaultSize: 44, trexMissing: false });
    expect(tfhdOf(0x20000, [], true)).toMatchObject({ baseDataOffset: 5000 });
    const all = tfhdOf(0x3b, [...u64(123456789012n), ...u32(2), ...u32(1001), ...u32(3000), ...u32(0x1010000)], true);
    expect(all).toMatchObject({ baseDataOffset: 123456789012, defaultDuration: 1001, defaultSize: 3000 });
    expect(tfhdOf(0x18, [...u32(512), ...u32(77)], false)).toMatchObject({ baseDataOffset: 7000, defaultDuration: 512, defaultSize: 77, trexMissing: true });
    expect(tfhdOf(0, [], false)).toMatchObject({ defaultDuration: null, trexMissing: true });
    expect(tfhdOf(0x01, [0, 0, 0], true)).toBeNull();
  });

  const base: Tfhd = { flags: 0, trackId: 1, baseDataOffset: 1000, defaultDuration: 512, defaultSize: 100, trexMissing: false };

  test('trun with every per-sample field, v0 composition offsets read as int32', () => {
    const fields = [...u32(16), ...u32(0x2000000)];
    for (const [d, s, c] of [
      [500, 10, 0xfffffc18],
      [600, 20, 2000],
    ]) {
      fields.push(...u32(d), ...u32(s), ...u32(0x1010000), ...u32(c));
    }
    const b = trun(0, 0xf05, 2, fields);
    const warnings: string[] = [];
    const { fragment, dataEnd } = parseTrun(view(b), 8, b.length, base, 0, 1e6, warnings, 1e6);
    expect(Array.from(fragment.durations!)).toEqual([500, 600]);
    expect(Array.from(fragment.cts!)).toEqual([-1000, 2000]);
    expect(fragment.durationSum).toBe(1100);
    expect(dataEnd).toBe(1016 + 30);
    expect(warnings).toEqual([]);
  });

  test('trun v1 signed offsets and defaults from tfhd', () => {
    const b = trun(1, 0x800, 3, [...u32(-2002 >>> 0), ...u32(0), ...u32(1001)]);
    const { fragment } = parseTrun(view(b), 8, b.length, base, 2000, 1e6, [], 1e6);
    expect(fragment.durations).toBeNull();
    expect(fragment.defaultDuration).toBe(512);
    expect(fragment.durationSum).toBe(1536);
    expect(Array.from(fragment.cts!)).toEqual([-2002, 0, 1001]);
  });

  test('trun count beyond its payload uses the available entries and warns', () => {
    const b = trun(0, 0x100, 1000, [...u32(512), ...u32(512), ...u32(512)]);
    const warnings: string[] = [];
    const { fragment } = parseTrun(view(b), 8, b.length, base, 0, 1e6, warnings, 1e6);
    expect(fragment.count).toBe(3);
    expect(warnings[0]).toMatch(/declares 1000 entries but its box holds only 3/);
  });

  test('trun samples are counted as present or complete against the file size', () => {
    const b = trun(0, 0x200, 4, [...u32(100), ...u32(100), ...u32(100), ...u32(100)]);
    const { fragment } = parseTrun(view(b), 8, b.length, base, 1000, 1250, [], 1e6);
    expect(fragment.present).toBe(3);
    expect(fragment.complete).toBe(2);
    const plain = trun(0, 0, 10, []);
    const fixed = parseTrun(view(plain), 8, plain.length, base, 1000, 1350, [], 1e6).fragment;
    expect(fixed.present).toBe(4);
    expect(fixed.complete).toBe(3);
  });

  test('a sample duration that nothing defines is an error', () => {
    const b = trun(0, 0, 3, []);
    expect(() => parseTrun(view(b), 8, b.length, { ...base, defaultDuration: null }, 0, 1e6, [], 1e6)).toThrow(/no sample duration for track 1/);
  });
});

describe('rotation, codecs, rounding', () => {
  test('rotation follows ffprobe: tkhd x mvhd matrix, -atan2, truncated', () => {
    expect(displayRotation(IDENTITY, IDENTITY)).toBe(0);
    expect(displayRotation(ROT90, IDENTITY)).toBe(-90);
    expect(displayRotation([-65536, 0, 0, 0, -65536, 0, 0, 0, 1 << 30], IDENTITY)).toBe(-180);
    expect(displayRotation([0, -65536, 0, 65536, 0, 0, 0, 0, 1 << 30], IDENTITY)).toBe(90);
    expect(displayRotation(ROT90, ROT90)).toBe(-180);
    expect(displayRotation([0, 131072, 0, -131072, 0, 0, 0, 0, 1 << 30], IDENTITY)).toBe(-90);
    expect(displayRotation(zeros(9), IDENTITY)).toBe(0);
  });

  test('fourcc table and esds remap', () => {
    expect(codecNameFor('avc1')).toBe('h264');
    expect(codecNameFor('avc3')).toBe('h264');
    expect(codecNameFor('hvc1')).toBe('hevc');
    expect(codecNameFor('hev1')).toBe('hevc');
    expect(codecNameFor('dvh1', null, true)).toBe('hevc');
    expect(codecNameFor('dvh1')).toBe('dvvideo');
    expect(codecNameFor('vp09')).toBe('vp9');
    expect(codecNameFor('av01')).toBe('av1');
    expect(codecNameFor('vvc1')).toBe('vvc');
    expect(codecNameFor('ap4x')).toBe('prores');
    expect(codecNameFor('AVdh')).toBe('dnxhd');
    expect(codecNameFor('jpeg')).toBe('mjpeg');
    expect(codecNameFor('m2v1')).toBe('mpeg2video');
    expect(codecNameFor('rle ')).toBe('qtrle');
    expect(codecNameFor('mp4v')).toBe('mpeg4');
    expect(codecNameFor('mp4v', 0x6c)).toBe('mjpeg');
    expect(codecNameFor('zzzz')).toBe('unknown');
    expect(isVideoFourcc('tmcd')).toBe(false);
    expect(isVideoFourcc('mp4a')).toBe(false);
  });

  test('av_rescale rounds half away from zero', () => {
    expect(rescaleRound(1, 1, 2)).toBe(1);
    expect(rescaleRound(3, 1, 2)).toBe(2);
    expect(rescaleRound(-1, 1, 2)).toBe(-1);
    expect(rescaleRound(1000, 15360, 1000)).toBe(15360);
    expect(rescaleRound(2303, 30000, 1000)).toBe(69090);
    expect(rescaleRound(1, 2, 0)).toBe(0);
  });
});

describe('ffprobe stage-1 r_frame_rate', () => {
  function track(spec: Partial<IsoTrack>): IsoTrack {
    return { ...newTrack(), id: 1, timescale: 3000, hasMdhd: true, ...spec };
  }

  test('an early-ending edit keeps the index up to the next keyframe (61 of 150 samples)', async () => {
    const file = bytes(
      ftyp(),
      moov(
        trak({
          id: 1,
          ts: 3000,
          stts: [
            [60, 110],
            [90, 200],
          ],
          sync: [1, 31, 61, 91, 121],
          edits: [[2200, 0]],
        }),
      ),
    );
    const r = await run(file);
    expect(r.error).toBeNull();
    expect(r.videoTracks[0].rFpsFfprobe).toBe('300/11');
    expect(r.videoTracks[0].presentedFrames).toBe(60);
  });

  test('with ctts the cut waits for one more keyframe, so the rate is no longer constant', async () => {
    const spec: TrakSpec = {
      id: 1,
      ts: 3000,
      stts: [
        [60, 110],
        [90, 200],
      ],
      ctts: [[150, 0]],
      sync: [1, 31, 61, 91, 121],
      edits: [[2200, 0]],
    };
    expect((await run(bytes(ftyp(), moov(trak(spec))))).videoTracks[0].rFpsFfprobe).toBeNull();
    expect((await run(bytes(ftyp(), moov(trak({ ...spec, sync: undefined }))))).videoTracks[0].rFpsFfprobe).toBe('300/11');
  });

  test('without edits only the last duration may differ', () => {
    const movie = newMovie(1e6);
    const lastDiffers = track({ sttsCounts: Uint32Array.from([89, 1]), sttsDeltas: Uint32Array.from([1001, 500]), sampleCount: 90, timescale: 30000 });
    expect(ffprobeStage1Rate(lastDiffers, movie, 90, 1e6)?.num).toBe(30000);
    const middle = track({ sttsCounts: Uint32Array.from([40, 1, 49]), sttsDeltas: Uint32Array.from([1001, 500, 1001]), sampleCount: 90, timescale: 30000 });
    expect(ffprobeStage1Rate(middle, movie, 90, 1e6)).toBeNull();
    expect(ffprobeStage1Rate(track({ sttsCounts: Uint32Array.from([90]), sttsDeltas: Uint32Array.from([1001]), sampleCount: null }), movie, 90, 1e6)).toBeNull();
  });
});

describe('synthetic files end to end', () => {
  const mdat = (n: number): Bytes => box('mdat', zeros(n));

  test('above the single-read size faststart needs one read, moov at the end two', async () => {
    const tail = await run(bytes(ftyp(), mdat(500_000), moov(trak({ ...CFR30(), chunkOffset: 40 }))));
    expect(tail.error).toBeNull();
    expect(tail.io.reads).toBe(2);
    expect(tail.videoTracks[0]).toMatchObject({ frames: 90, presentedFrames: 90, avgFpsFfprobe: '30/1', rFpsFfprobe: '30/1', durationSec: 3, startSec: 0, isVfr: false });
    const fast = await run(bytes(ftyp(), moov(trak(CFR30())), mdat(500_000)));
    expect(fast.io).toMatchObject({ reads: 1, bytesRead: 65_536 });
    expect(fast.formatDurationSec).toBe(3);
  });

  test('below the single-read size one read covers the file in any layout, unless reads cost nothing', async () => {
    const file = bytes(ftyp(), mdat(200_000), moov(trak({ ...CFR30(), chunkOffset: 40 })));
    const whole = await run(file);
    expect(whole.io).toMatchObject({ reads: 1, bytesRead: file.length });
    const split = await run(file, { costModel: { perReadMs: 0 } });
    expect(split.io.reads).toBe(2);
    expect({ ...whole.videoTracks[0], warnings: [] }).toEqual({ ...split.videoTracks[0], warnings: [] });
    const fast = await run(bytes(ftyp(), moov(trak(CFR30())), mdat(200_000)));
    expect(fast.io.reads).toBe(1);
  });

  test('a top-level uuid box, a 64-bit mdat and a size-0 mdat are skipped by size', async () => {
    const uuid = bytes(u32(64), tag('uuid'), zeros(56));
    const mdat64 = bytes(u32(1), tag('mdat'), u64(80_016n), zeros(80_000));
    const r = await run(bytes(ftyp(), uuid, mdat64, moov(trak(CFR30())), bytes(u32(0), tag('mdat'), zeros(5000))));
    expect(r.error).toBeNull();
    expect(r.videoTracks).toHaveLength(1);
  });

  test('missing moov, moof before moov, cmov and a cut moov are errors', async () => {
    expect((await run(bytes(ftyp(), mdat(1000)))).error).toBe('incomplete file: no moov');
    expect((await run(bytes(ftyp(), moof(1, []), moov(trak(CFR30()))))).error).toBe('corrupt file: movie fragment (moof) before moov');
    expect((await run(bytes(ftyp(), box('moov', box('cmov', zeros(20)))))).error).toBe('unsupported: compressed movie header (cmov)');
    const whole = bytes(ftyp(), mdat(100), moov(trak(CFR30())));
    const cut = await run(whole.subarray(0, whole.length - 200));
    expect(cut.error).toBe('incomplete file: moov is truncated');
    expect(cut.container).toBe('mp4');
  });

  test('a moov size past the end of the file is parsed when its children are complete', async () => {
    const m = moov(trak(CFR30()));
    new DataView(m.buffer, m.byteOffset).setUint32(0, m.length + 5000);
    const r = await run(bytes(ftyp(), mdat(100), m));
    expect(r.error).toBeNull();
    expect(r.warnings.join('\n')).toMatch(/moov size exceeds the file/);
    expect(r.videoTracks[0].frames).toBe(90);
  });

  test('stts entry_count is bounded by the box size', async () => {
    const r = await run(bytes(ftyp(), moov(trak({ ...CFR30(), sttsDeclared: 2147483647 }))));
    expect(r.error).toBeNull();
    expect(r.videoTracks[0].frames).toBe(90);
    expect(r.videoTracks[0].warnings.join('\n')).toMatch(/stts declares 2147483647 entries/);
  });

  test('container kind comes from the major brand', async () => {
    expect((await run(bytes(ftyp('qt  '), moov(trak(CFR30()))))).container).toBe('mov');
    expect((await run(bytes(moov(trak(CFR30())), mdat(10)))).container).toBe('mov');
    const mp4 = await run(bytes(ftyp('M4V '), moov(trak(CFR30()))));
    expect(mp4.container).toBe('mp4');
    expect(mp4.brand).toBe('M4V ');
  });

  test('track roles: tmcd, chapter text and audio are not video; primary is the enabled track with most samples', async () => {
    const tmcd = trak({ id: 5, handler: 'tmcd', entry: box('tmcd', zeros(30)), stts: [[1, 1000]] });
    const chapter = trak({ id: 6, handler: 'text', entry: box('text', zeros(60)), stts: [[2, 1000]] });
    const audio = trak({ id: 7, handler: 'soun', entry: box('mp4a', zeros(28)), ts: 48000, stts: [[141, 1024]] });
    const still = trak({ id: 1, stts: [[1, 512]] });
    const big = trak({ id: 2, stts: [[120, 512]], flags: 2 });
    const main = trak({ id: 3, stts: [[90, 512]], extra: [box('tref', box('chap', u32(6)))] });
    const r = await run(bytes(ftyp(), moov(still, big, main, tmcd, chapter, audio)));
    expect(r.error).toBeNull();
    expect(r.videoTracks.map((t) => t.trackId)).toEqual([1, 2, 3]);
    expect(r.videoTracks[0].isStill).toBe(true);
    expect(r.audioTrackCount).toBe(1);
    expect(r.primaryTrackId).toBe(3);
    const audioOnly = await run(bytes(ftyp('M4A '), moov(audio)));
    expect(audioOnly.videoTracks).toEqual([]);
    expect(audioOnly.primaryTrackId).toBeNull();
    expect(audioOnly.formatDurationSec).toBeCloseTo((141 * 1024) / 48000, 6);
    const onlyStill = await run(bytes(ftyp(), moov(still)));
    expect(primaryTrack(onlyStill)?.isStill).toBe(true);
  });

  test('rotation and encrypted sample entries', async () => {
    const enc = visualEntry('encv', 160, 90, box('sinf', box('frma', tag('avc1')), box('schm', zeros(12))));
    const r = await run(bytes(ftyp(), moov(trak({ ...CFR30(), matrix: ROT90, entry: enc }))));
    const t = r.videoTracks[0];
    expect(t.rotation).toBe(-90);
    expect(t.width).toBe(160);
    expect(t.fourccOrCodecId).toBe('encv');
    expect(t.codecName).toBe('h264');
    expect(t.warnings.join('\n')).toMatch(/encrypted: encv of avc1/);
  });

  test('empty edit, B-frame composition offsets and the presentation window', async () => {
    const spec: TrakSpec = {
      id: 1,
      ts: 30000,
      stts: [[90, 1001]],
      ctts: [[90, 2002]],
      sync: [1, 31, 61],
      edits: [
        [500, -1],
        [2000, 2002],
      ],
    };
    const r = await run(bytes(ftyp(), moov(trak(spec))));
    const t = r.videoTracks[0];
    expect(t.startSec).toBeCloseTo(0.5, 9);
    expect(t.durationSec).toBeCloseTo(2.5, 9);
    expect(t.presentedFrames).toBe(60);
    expect(t.frames).toBe(90);
  });

  const fragmented = (trexDuration: number | null, tfhdFlags: number, tfhdFields: number[], runs: Uint8Array[]): Bytes =>
    bytes(
      ftyp('iso5'),
      moov(trak({ id: 1, stts: [] }), mvex(trexDuration)),
      ...runs.flatMap((r, i) => [moof(i + 1, [traf(tfhdFlags, tfhdFields, i * 30 * 512, r)]), mdat(300)]),
    );

  test('fragmented: trex defaults, every moof read, coalesced reads', async () => {
    const runs = [0, 1, 2].map(() => trun(0, 0x201, 30, [...u32(0), ...new Array<number>(30).fill(0).flatMap(() => u32(10))]));
    const r = await run(fragmented(512, 0x20000, [], runs));
    expect(r.error).toBeNull();
    const t = r.videoTracks[0];
    expect(t).toMatchObject({ frames: 90, presentedFrames: 90, avgFpsFfprobe: '30/1', rFpsFfprobe: null, durationSec: 3 });
    expect(r.io.reads).toBe(1);
  });

  test('fragmented without trex: parsed from tfhd defaults, ffprobe 8.1.1 rejects the file', async () => {
    const runs = [0, 1].map(() => trun(0, 0, 30, []));
    const r = await run(fragmented(null, 0x08, u32(512), runs));
    expect(r.error).toBeNull();
    const t = r.videoTracks[0];
    expect(t.avgFps?.num).toBe(30);
    expect(t.frames).toBe(60);
    expect(t.avgFpsFfprobe).toBeNull();
    expect(t.rFpsFfprobe).toBeNull();
    expect(t.warnings.join('\n')).toMatch(/no trex: sample defaults taken from tfhd/);
    expect(r.warnings.join('\n')).toMatch(/ffprobe 8\.1\.1 rejects this file: trun without a tfhd that has a trex/);
  });

  test('a traf without trex after a valid traf in the same moof is flagged as unreproducible', async () => {
    const valid = traf(0x20000, [], 0, trun(0, 0x001, 30, u32(0)));
    const orphan = box('traf', fullBox('tfhd', 0, 0x20008, u32(2), u32(512)), trun(0, 0x001, 30, u32(0)));
    const file = bytes(ftyp('iso5'), moov(trak({ id: 1, stts: [] }), trak({ id: 2, stts: [] }), mvex(512)), moof(1, [valid, orphan]), mdat(300));
    const r = await run(file);
    expect(r.error).toBeNull();
    expect(r.warnings.join('\n')).toMatch(/ffprobe 8\.1\.1 misreads this file: a traf without trex is read as another track/);
    expect(r.videoTracks.map((t) => t.avgFpsFfprobe)).toEqual([null, null]);
  });

  test('fragmented with no duration anywhere is an error', async () => {
    const r = await run(fragmented(null, 0, [], [trun(0, 0, 30, [])]));
    expect(r.error).toBe('corrupt file: no sample duration for track 1');
  });

  test('an abort during the walk propagates instead of becoming a result', async () => {
    const file = new Blob([bytes(ftyp(), mdat(500_000), moov(trak(CFR30())))]);
    const controller = new AbortController();
    let reads = 0;
    const blob = {
      size: file.size,
      slice: (start?: number, end?: number) => ({
        arrayBuffer: async () => {
          if (++reads === 2) controller.abort();
          return file.slice(start, end).arrayBuffer();
        },
      }),
    };
    await expect(analyze(blob, 'abort.mp4', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('indexed fragment prefetch (sidx, mfra)', () => {
  const FRAGMENTS = 24;
  const MDAT_PAYLOAD = 100_000;
  const SAMPLE = Math.floor(MDAT_PAYLOAD / 30);

  function fragmentPair(i: number): Bytes {
    const make = (offset: number): Bytes => moof(i + 1, [traf(0x20018, [...u32(512), ...u32(SAMPLE)], i * 30 * 512, trun(0, 0x001, 30, u32(offset)))]);
    const first = make(0);
    return bytes(make(first.length + 8), box('mdat', zeros(MDAT_PAYLOAD)));
  }

  function file(index: 'none' | 'sidx' | 'mfra', tfraOffset = (offset: number, _i: number): bigint => BigInt(offset)): Bytes {
    const head = bytes(ftyp('iso5'), moov(trak({ id: 1, stts: [] }), mvex(0)));
    const pairs = Array.from({ length: FRAGMENTS }, (_, i) => fragmentPair(i));
    const refs = pairs.flatMap((p) => [...u32(p.length), ...u32(30 * 512), ...u32(0x90000000)]);
    const sidx = index === 'sidx' ? fullBox('sidx', 0, 0, u32(1), u32(15360), u32(0), u32(0), u16(0), u16(FRAGMENTS), refs) : new Uint8Array(0);
    let offset = head.length + sidx.length;
    const entries: number[] = [];
    pairs.forEach((p, i) => {
      entries.push(...u64(BigInt(i * 30 * 512)), ...u64(tfraOffset(offset, i)), 1, 1, 1);
      offset += p.length;
    });
    const tfra = fullBox('tfra', 1, 0, u32(1), u32(0), u32(FRAGMENTS), entries);
    const mfra = index === 'mfra' ? box('mfra', tfra, fullBox('mfro', 0, 0, u32(tfra.length + 24))) : new Uint8Array(0);
    return bytes(head, sidx, ...pairs, mfra);
  }

  function tracked(data: Bytes): { blob: { size: number; slice(s?: number, e?: number): { arrayBuffer(): Promise<ArrayBuffer> } }; maxInFlight: () => number } {
    const source = new Blob([data]);
    let inFlight = 0;
    let max = 0;
    return {
      blob: {
        size: source.size,
        slice: (s?: number, e?: number) => ({
          arrayBuffer: async () => {
            inFlight++;
            max = Math.max(max, inFlight);
            try {
              await new Promise((resolve) => setTimeout(resolve, 1));
              return await source.slice(s, e).arrayBuffer();
            } finally {
              inFlight--;
            }
          },
        }),
      },
      maxInFlight: () => max,
    };
  }

  test('tfra offsets are read for every entry layout', () => {
    const v0 = fullBox('tfra', 0, 0, u32(1), u32(0x15), u32(2), [...u32(0), ...u32(1000), 0, 1, 0, 1, 0, 1, ...u32(5), ...u32(2000), 0, 1, 0, 1, 0, 2]);
    const v1 = fullBox('tfra', 1, 0, u32(2), u32(0), u32(1), [...u64(7n), ...u64(5_000_000_000n), 1, 1, 1]);
    const out = new Set<number>();
    const both = bytes(v0, v1);
    parseTfraOffsets(view(both), 0, both.length, out);
    expect([...out]).toEqual([1000, 2000, 5_000_000_000]);
  });

  test('sidx and mfra give the same results as the sequential walk, with parallel reads', async () => {
    const results = [];
    for (const index of ['none', 'sidx', 'mfra'] as const) {
      const t = tracked(file(index));
      const r = await analyze(t.blob, `${index}.mp4`);
      expect(r.error).toBeNull();
      results.push({ index, track: r.videoTracks[0], maxInFlight: t.maxInFlight(), reads: r.io.reads });
    }
    for (const { track } of results) {
      expect(track).toMatchObject({ frames: FRAGMENTS * 30, presentedFrames: FRAGMENTS * 30, avgFpsFfprobe: '30/1', isVfr: false });
      expect(track.durationSec).toBeCloseTo((FRAGMENTS * 30 * 512) / 15360, 9);
    }
    expect(results[0].maxInFlight).toBe(1);
    expect(results[1].maxInFlight).toBeGreaterThan(1);
    expect(results[2].maxInFlight).toBeGreaterThan(1);
    expect(results[1].reads).toBeLessThanOrEqual(results[0].reads + 1);
  });

  test('a tfra offset above 2^53 is ignored instead of failing the file', async () => {
    const base = await analyze(new Blob([file('none')]), 'none.mp4');
    const huge = await analyze(new Blob([file('mfra', (o, i) => (i === FRAGMENTS - 1 ? 2n ** 54n : BigInt(o)))]), 'huge.mp4');
    expect(huge.error).toBeNull();
    expect(huge.videoTracks[0]).toEqual(base.videoTracks[0]);
  });

  test('stale tfra offsets stop the prefetch after one batch and keep the results', async () => {
    const base = await analyze(new Blob([file('none')]), 'none.mp4');
    const stale = await analyze(new Blob([file('mfra', (o) => BigInt(o + 100))]), 'stale.mp4');
    expect(stale.error).toBeNull();
    expect(stale.videoTracks[0]).toEqual(base.videoTracks[0]);
    expect(stale.io.reads).toBeLessThanOrEqual(base.io.reads + 1 + PREFETCH_BATCH);
  });
});

describe('adversarial review regressions', () => {
  const mdat = (n: number): Bytes => box('mdat', zeros(n));
  const elstBox = (declared: number, entries: Array<[number, number]>): Bytes =>
    fullBox('elst', 0, 0, u32(declared), entries.flatMap(([d, t]) => [...u32(d), ...u32(t >>> 0), ...u32(0x10000)]));
  const fragmentedFile = (trexDuration: number | null, runs: Uint8Array[], tfdt = (i: number): number => i * 30 * 512): Bytes =>
    bytes(
      ftyp('iso5'),
      moov(trak({ id: 1, stts: [] }), mvex(trexDuration)),
      ...runs.flatMap((r, i) => [moof(i + 1, [traf(0x20000, [], tfdt(i), r)]), mdat(300)]),
    );
  const sizedRun = (): Bytes => trun(0, 0x201, 30, [...u32(0), ...new Array<number>(30).fill(0).flatMap(() => u32(10))]);

  test('thousands of edits over a VFR stts stay bounded and match ffprobe stage 1', async () => {
    const edits = Array.from({ length: 2000 }, (): [number, number] => [0x7fffffff, 0]);
    const file = bytes(
      ftyp(),
      moov(
        trak({
          id: 1,
          ts: 30000,
          stts: [
            [49_999, 1001],
            [1, 2002],
          ],
          edits,
        }),
      ),
    );
    const started = performance.now();
    const r = await run(file);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(r.error).toBeNull();
    expect(r.videoTracks[0].rFpsFfprobe).toBe('30000/1001');
  });

  test('the edit walk with composition offsets has a work limit', async () => {
    const spec: TrakSpec = {
      id: 1,
      ts: 30000,
      stts: [
        [149_999, 1001],
        [1, 2002],
      ],
      ctts: [
        [75_000, 0],
        [75_000, 2002],
      ],
      edits: [[0x7fffffff, 0]],
    };
    const file = bytes(ftyp(), moov(trak(spec)));
    expect((await run(file)).videoTracks[0].rFpsFfprobe).toBe('30000/1001');
    const limited = (await run(file, { maxExpandedSamples: 100_000 })).videoTracks[0];
    expect(limited.rFpsFfprobe).toBeNull();
    expect(limited.warnings.join('\n')).toMatch(/r_frame_rate not reproduced: edit list walk limit reached/);
  });

  test('stage 1 takes the retained count from the index walk but the durations from the start of stts (ffprobe 8.1.1)', async () => {
    const spec = (edit: [number, number]): TrakSpec => ({
      id: 1,
      ts: 90000,
      stts: [
        [20, 9000],
        [60, 3000],
        [120, 1500],
      ],
      sync: [1, 31, 61, 91, 121, 151, 181],
      edits: [edit],
    });
    const one = (await run(bytes(ftyp(), moov(trak(spec([33, 210000])))))).videoTracks[0];
    expect(one.rFpsFfprobe).toBe('10/1');
    expect(one.presentedFrames).toBe(1);
    const many = (await run(bytes(ftyp(), moov(trak(spec([300, 270000])))))).videoTracks[0];
    expect(many.rFpsFfprobe).toBeNull();
  });

  test('a truncated file whose moov ends in an empty stco does not throw', async () => {
    const stbl = box(
      'stbl',
      stsd(visualEntry('avc1')),
      stts([[10, 1000]]),
      fullBox('stsz', 0, 0, u32(100), u32(10)),
      fullBox('stsc', 0, 0, u32(1), u32(1), u32(10), u32(1)),
      box('stco'),
    );
    const track = box('trak', tkhd(1), box('mdia', mdhd(30000, 10000), hdlr('vide'), box('minf', stbl)));
    const file = bytes(ftyp(), moov(track), u32(8 + 1000), tag('mdat'), zeros(300));
    const direct = await analyzeIsoBmff(new BlobReader(new Blob([file])), resolveOptions());
    expect(direct.error).toBeNull();
    const r = await run(file);
    expect(r.error).toBeNull();
    expect(r.videoTracks[0]).toMatchObject({ frames: 10, presentedFrames: 0, durationSec: null });
    expect(r.videoTracks[0].warnings.join('\n')).toMatch(/missing mandatory sample tables/);
  });

  test('an auxv track with a video sample entry is video, counts for the format duration and is not primary', async () => {
    const r = await run(bytes(ftyp(), moov(trak(CFR30()), trak({ id: 2, handler: 'auxv', stts: [[120, 512]] }))));
    expect(r.videoTracks.map((t) => t.trackId)).toEqual([1, 2]);
    expect(r.videoTracks[1].warnings.join('\n')).toMatch(/auxiliary video track/);
    expect(r.formatDurationSec).toBe(4);
    expect(r.primaryTrackId).toBe(1);
  });

  test('duplicate track_IDs get a distinct reported id so primaryTrack() is the picked track', async () => {
    const r = await run(bytes(ftyp(), moov(trak(CFR30()), trak({ id: 1, stts: [[120, 512]] }))));
    expect(r.videoTracks.map((t) => t.trackId)).toEqual([1, 2]);
    expect(r.warnings.join('\n')).toMatch(/duplicate track_ID/);
    expect(r.videoTracks[1].warnings.join('\n')).toMatch(/duplicate track_ID 1: reported as 2/);
    expect(r.primaryTrackId).toBe(2);
    expect(primaryTrack(r)?.frames).toBe(120);
  });

  test('a second elst replaces the first, and the entry count follows the box size like ffmpeg', async () => {
    const withEdts = (...elsts: Uint8Array[]): Bytes => bytes(ftyp(), moov(trak({ ...CFR30(), extra: [box('edts', ...elsts)] })));
    const two = await run(withEdts(elstBox(1, [[3000, 0]]), elstBox(1, [[1000, 0]])));
    expect(two.videoTracks[0]).toMatchObject({ durationSec: 1, presentedFrames: 30 });
    expect(two.formatDurationSec).toBe(1);
    expect(two.videoTracks[0].warnings.join('\n')).toMatch(/duplicated elst/);
    const emptySecond = await run(withEdts(elstBox(1, [[1000, 0]]), elstBox(0, [])));
    expect(emptySecond.videoTracks[0].durationSec).toBe(1);
    const undercounted = await run(
      withEdts(
        elstBox(1, [
          [1000, 0],
          [1000, 15360],
        ]),
      ),
    );
    expect(undercounted.videoTracks[0].durationSec).toBe(2);
  });

  test('stts describing more samples than stsz: the timeline stops at the stsz count', async () => {
    const r = await run(bytes(ftyp(), moov(trak({ id: 1, stts: [[1000, 512]], sampleCount: 90 }))));
    const t = r.videoTracks[0];
    expect(t.frames).toBe(1000);
    expect(t.presentedFrames).toBe(90);
    expect(t.warnings.join('\n')).toMatch(/stts describes 1000 samples but the sample size table holds 90/);
  });

  test('a record-less trun with a huge count only yields the samples whose data is in the file', async () => {
    const huge = trun(0, 0, 33_554_432, []);
    const file = bytes(ftyp('iso5'), moov(trak({ id: 1, stts: [] }), mvex(512)), moof(1, [traf(0x20010, u32(10), 0, huge)]), mdat(300));
    const started = performance.now();
    const r = await run(file);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(r.error).toBeNull();
    const t = r.videoTracks[0];
    expect(t.frames).toBeLessThanOrEqual(Math.ceil(file.length / 10));
    expect(t.presentedFrames).toBeLessThanOrEqual(t.frames!);
    expect(t.avgFpsFfprobe).toBe('30/1');
  });

  test('avg_frame_rate of ffprobe is not claimed when ffprobe falls back to heuristics or reads past a box', async () => {
    const zero = (await run(bytes(ftyp(), moov(trak({ id: 1, stts: [[90, 0]] }))))).videoTracks[0];
    expect(zero.avgFpsFfprobe).toBeNull();
    const overrun = (await run(bytes(ftyp(), moov(trak({ ...CFR30(), sttsDeclared: 2147483647 }))))).videoTracks[0];
    expect(overrun.avgFpsFfprobe).toBeNull();
    expect(overrun.rFpsFfprobe).toBeNull();
    expect(overrun.avgFps?.num).toBe(30);
    const runOverrun = trun(0, 0x201, 1000, [...u32(0), ...new Array<number>(30).fill(0).flatMap(() => u32(10))]);
    const frag = (await run(fragmentedFile(512, [sizedRun(), runOverrun]))).videoTracks[0];
    expect(frag.avgFpsFfprobe).toBeNull();
    expect(frag.avgFps?.num).toBe(30);
  });

  test('64-bit fields above 2^53 and a truncated sidx give errors that name the box', async () => {
    const tfdt = await run(fragmentedFile(512, [sizedRun()], () => 2 ** 54));
    expect(tfdt.error).toMatch(/^unsupported: box 'tfdt' at \d+ holds a value above 2\^53-1$/);
    const head = bytes(ftyp('iso5'), moov(trak({ id: 1, stts: [] }), mvex(512)));
    const sidx = fullBox('sidx', 1, 0, u32(1), u32(15360), u32(0), u32(0), u32(0));
    const short = await run(bytes(head, sidx, moof(1, [traf(0x20000, [], 0, sizedRun())]), mdat(300)));
    expect(short.error).toBe(`corrupt file: box 'sidx' at ${head.length} is truncated`);
    const cutAtEof = await run(bytes(head, moof(1, [traf(0x20000, [], 0, sizedRun())]), mdat(300), fullBox('sidx', 1, 0, u32(1), u32(15360), zeros(40)).subarray(0, 20)));
    expect(cutAtEof.error).toBeNull();
    expect(cutAtEof.videoTracks[0].frames).toBe(30);
  });

  test('a track failing the mandatory-atom check keeps no timing and only its mdhd duration at 1/90000 counts for the format', async () => {
    const broken: TrakSpec = {
      id: 2,
      stts: [],
      mdhdDuration: 4 * 15360,
      tables: [fullBox('stsz', 0, 0, u32(0), u32(0)), fullBox('stsc', 0, 0, u32(1), u32(1), u32(1), u32(1)), fullBox('stco', 0, 0, u32(1), u32(0))],
    };
    const r = await run(bytes(ftyp(), moov(trak(CFR30()), trak(broken))));
    expect(r.formatDurationSec).toBe(3);
    const t = r.videoTracks[1];
    expect(t).toMatchObject({ trackId: 2, durationSec: null, startSec: null, presentedFrames: 0, rFpsFfprobe: null });
    expect(t.warnings.join('\n')).toMatch(/missing mandatory sample tables/);
    expect(r.primaryTrackId).toBe(1);
  });
});

describe('64-bit all-ones durations', () => {
  const ALL_ONES = 0xffffffffffffffffn;
  const mdat = (n: number): Bytes => box('mdat', zeros(n));
  const elst64 = (duration: bigint, mediaTime: bigint): Bytes => box('edts', fullBox('elst', 1, 0, u32(1), u64(duration), u64(BigInt.asUintN(64, mediaTime)), u32(0x10000)));
  const sameExceptWarnings = (a: FileResult, b: FileResult, ffprobeFails = false): void => {
    const strip = (r: FileResult) => ({ ...r, size: 0, io: null, warnings: [], videoTracks: r.videoTracks.map((t) => ({ ...t, warnings: [], ...(ffprobeFails ? { avgFpsFfprobe: null, rFpsFfprobe: null } : {}) })) });
    expect(strip(a)).toEqual(strip(b));
  };

  test('an all-ones mehd is ignored like ffprobe, which never reads mehd', async () => {
    const trex = fullBox('trex', 0, 0, u32(1), u32(1), u32(512), u32(0), u32(0));
    const runs = [0, 1, 2].map((i) => moof(i + 1, [traf(0x20000, [], i * 30 * 512, trun(0, 0x201, 30, [...u32(0), ...new Array<number>(30).fill(0).flatMap(() => u32(10))]))]));
    const file = (...mvexChildren: Uint8Array[]): Bytes => bytes(ftyp('iso5'), moov(trak({ id: 1, stts: [] }), box('mvex', ...mvexChildren)), ...runs.flatMap((m) => [m, mdat(300)]));
    const plain = await run(file(trex));
    const ones = await run(file(fullBox('mehd', 1, 0, u64(ALL_ONES)), trex));
    expect(ones.error).toBeNull();
    expect(ones.videoTracks[0]).toMatchObject({ frames: 90, presentedFrames: 90, durationSec: 3 });
    expect(ones).toEqual({ ...plain, size: ones.size, io: ones.io });
    expect((await run(file(fullBox('mehd', 0, 0, u32(0xffffffff)), trex))).error).toBeNull();
  });

  test('an all-ones elst version 1 segment duration lasts to the end of the media, with a warning; ffprobe 8.1.1 fails the file', async () => {
    const plain = await run(bytes(ftyp(), moov(trak(CFR30()))));
    const ones = await run(bytes(ftyp(), moov(trak({ ...CFR30(), extra: [elst64(ALL_ONES, 0n)] }))));
    expect(ones.error).toBeNull();
    expect(ones.warnings).toEqual(['ffprobe 8.1.1 rejects this file: an elst segment duration of -1']);
    expect(ones.videoTracks[0].warnings).toEqual(['elst segment duration 0xffffffffffffffff is unknown: the edit lasts to the end']);
    expect(ones.videoTracks[0]).toMatchObject({ avgFpsFfprobe: null, rFpsFfprobe: null });
    sameExceptWarnings(ones, plain, true);
    const bframes: TrakSpec = { id: 1, ts: 30000, stts: [[90, 1001]], ctts: [[90, 2002]], sync: [1, 31, 61] };
    const real = await run(bytes(ftyp(), moov(trak({ ...bframes, edits: [[3003, 2002]] }))));
    const unknown = await run(bytes(ftyp(), moov(trak({ ...bframes, extra: [elst64(ALL_ONES, 2002n)] }))));
    expect(unknown.videoTracks[0]).toMatchObject({ presentedFrames: 90, startSec: 0 });
    expect(unknown.videoTracks[0].durationSec).toBeCloseTo(3.003, 9);
    sameExceptWarnings(unknown, real, true);
    expect((await run(bytes(ftyp(), moov(trak({ ...CFR30(), extra: [elst64(2n ** 60n, 0n)] }))))).error).toMatch(/^unsupported: box 'elst' at \d+ holds a value above 2\^53-1$/);
  });

  test('all-ones mvhd, tkhd and mdhd version 1 durations keep the file; ffprobe 8.1.1 reads the mdhd one as 0', async () => {
    const mvhd64 = fullBox('mvhd', 1, 0, u64(0n), u64(0n), u32(1000), u64(ALL_ONES), u32(0x10000), u16(0x100), zeros(10), matrix(IDENTITY), zeros(24), u32(2));
    const tkhd64 = fullBox('tkhd', 1, 3, u64(0n), u64(0n), u32(1), u32(0), u64(ALL_ONES), zeros(8), u16(0), u16(0), u16(0), u16(0), matrix(IDENTITY), u32(160 << 16), u32(90 << 16));
    const mdhd64 = fullBox('mdhd', 1, 0, u64(0n), u64(0n), u32(15360), u64(ALL_ONES), u16(0x55c4), u16(0));
    const plain = await run(bytes(ftyp(), moov(trak(CFR30()))));
    sameExceptWarnings(await run(bytes(ftyp(), box('moov', mvhd64, trak(CFR30())))), plain);
    sameExceptWarnings(await run(bytes(ftyp(), moov(trak({ ...CFR30(), trackHeader: tkhd64 })))), plain);
    const media = await run(bytes(ftyp(), moov(trak({ ...CFR30(), mediaHeader: mdhd64 }))));
    expect(media.error).toBeNull();
    expect(media.formatDurationSec).toBeNull();
    expect(media.videoTracks[0]).toMatchObject({ frames: 90, presentedFrames: 90, durationSec: 0, avgFpsFfprobe: '30/1' });
  });
});

describe('data after moov', () => {
  const CONTROL = /[^\x20-\x7e\xa0-￿]/;
  const mdat = (n: number): Bytes => box('mdat', zeros(n));
  const everyWarning = (r: FileResult): string[] => [...r.warnings, ...r.videoTracks.flatMap((t) => t.warnings)];
  const moovAtEnd = bytes(ftyp('qt  '), mdat(80_000), moov(trak({ ...CFR30(), chunkOffset: 40 })));

  test('a trailer that is not a box after a complete moov and mdat is ignored instead of marking the file truncated', async () => {
    const plain = await run(moovAtEnd);
    const trailers = [[0x7f, 0xff, 0xff, 0xff, ...zeros(12)], [...u32(256), ...zeros(12)], [...u32(0x10000), 1, 2, 3, 0x9b, ...zeros(8)]];
    for (const trailer of trailers) {
      const r = await run(bytes(moovAtEnd, trailer));
      expect(r.warnings).toEqual([`ignored trailing data at ${moovAtEnd.length}: not a box`]);
      expect({ ...r, size: 0, io: null, warnings: [] }).toEqual({ ...plain, size: 0, io: null, warnings: [] });
    }
  });

  test('a cut mdat after a faststart moov is still a truncation', async () => {
    const head = bytes(ftyp(), moov(trak({ ...CFR30(), chunkOffset: 0 })));
    const fast = bytes(ftyp(), moov(trak({ ...CFR30(), chunkOffset: head.length + 8 })), mdat(900));
    const cut = await run(fast.subarray(0, fast.length - 450));
    expect(cut.warnings).toEqual([`'mdat' at ${head.length} is truncated`]);
    expect(cut.videoTracks[0]).toMatchObject({ frames: 90, presentedFrames: 45 });
  });

  test('warnings never carry NUL or other control characters from the file', async () => {
    const enc = visualEntry('enc\u0001', 160, 90, box('sinf', box('frma', [0, 0x61, 0x76, 0x63]), box('schm', zeros(12))));
    const r = await run(bytes(moovAtEnd.subarray(0, moovAtEnd.length - moov(trak({ ...CFR30(), chunkOffset: 40 })).length), moov(trak({ ...CFR30(), chunkOffset: 40, entry: enc })), [...u32(64), 0, 0, 0, 0, ...zeros(4)]));
    expect(everyWarning(r).join('\n')).toMatch(/encrypted: enc\? of \?avc/);
    expect(everyWarning(r).filter((w) => CONTROL.test(w))).toEqual([]);
  });
});

