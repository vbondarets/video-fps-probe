import { openAsBlob } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { aspectOf, withAspect } from '../../src/aspect/index.ts';
import { avReduce } from '../../src/aspect/rational.ts';
import { analyze } from '../../src/core/analyze.ts';
import { emptyTrack } from '../../src/core/result.ts';
import type { CodecConfig } from '../../src/core/types.ts';
import { analyzeHeader } from '../../src/header/index.ts';
import { ebml, h264Sps, uint } from '../color/bits.ts';
import { FILES_DIR } from '../helpers/fixtures.ts';
import { box, bytes, ftyp, fullBox, mdatHeader, tag, u16, u32, zeros } from '../helpers/iso-builder.ts';

const ratio = (r: { num: number; den: number } | null | undefined): string | null => (r ? `${r.num}:${r.den}` : null);

async function aspectOfFixture(name: string) {
  const blob = await openAsBlob(join(FILES_DIR, name));
  const result = name.endsWith('.mkv') ? withAspect(await analyze(blob, name, { codecConfig: true })) : await analyzeHeader(blob, { name, aspect: true });
  const t = result.videoTracks[0];
  return [ratio(t.sampleAspectRatio), ratio(t.displayAspectRatio), `${t.displayWidth}x${t.displayHeight}`];
}

const FIXTURES: Record<string, [string | null, string | null, string]> = {
  'sar_h264_4x3.mp4': ['4:3', '16:9', '1920x1080'],
  'sar_pasp_only.mp4': ['4:3', '64:27', '213x90'],
  'sar_tkhd_only.mp4': ['3:2', '8:3', '240x90'],
  'sar_matrix_scale.mp4': ['2:1', '32:9', '320x90'],
  'sar_tkhd_fraction.mp4': ['213:160', '71:40', '213x120'],
  'sar_vui_only.mp4': ['4:3', '16:9', '213x120'],
  'sar_tkhd_matrix.mp4': ['2:1', '32:9', '320x90'],
  'sar_pasp_tkhd_matrix.mp4': ['4:3', '64:27', '213x90'],
  'sar_none.mp4': [null, null, '160x90'],
  'sar_4x3.mkv': ['4:3', '16:9', '213x120'],
  'track_disabled.mp4': ['1:1', '16:9', '160x90'],
};

describe('the aspect of the SAR fixtures, as ffprobe 8.1.1 prints it', () => {
  for (const [name, expected] of Object.entries(FIXTURES)) {
    test(name, async () => {
      expect(await aspectOfFixture(name)).toEqual(expected);
    });
  }
});

const VISUAL = (width: number, height: number): Uint8Array => bytes(zeros(6), u16(1), zeros(16), u16(width), u16(height), u32(0x480000), u32(0x480000), u32(0), u16(1), zeros(32), u16(24), u16(0xffff));
const IDENTITY = [65536, 0, 0, 0, 65536, 0, 0, 0, 1 << 30];
const tkhd = (width: number, height: number, matrix = IDENTITY): Uint8Array => fullBox('tkhd', 0, 3, zeros(36), ...matrix.map((v) => u32(v >>> 0)), u32(width), u32(height));
const mvhd = (matrix = IDENTITY): Uint8Array => fullBox('mvhd', 0, 0, zeros(32), ...matrix.map((v) => u32(v >>> 0)), zeros(28));
const pasp = (h: number, v: number): Uint8Array => box('pasp', u32(h >>> 0), u32(v >>> 0));
const avcC = (sps: Uint8Array): Uint8Array => box('avcC', [1, 100, 0, 40, 0xff, 0xe1], u16(sps.length), sps, [0]);

function isoTrack(entries: Uint8Array[], options: { tkhd?: Uint8Array | null; mvhd?: Uint8Array | null; width?: number; height?: number; rotation?: number } = {}) {
  const config: CodecConfig = { family: 'isobmff', stsd: fullBox('stsd', 0, 0, u32(entries.length), ...entries), tkhd: options.tkhd === undefined ? tkhd(160 << 16, 90 << 16) : options.tkhd, mvhd: options.mvhd === undefined ? mvhd() : options.mvhd };
  return { codecName: 'h264', width: options.width ?? 160, height: options.height ?? 90, rotation: options.rotation ?? 0, codecConfig: config };
}

const avc1 = (...children: Uint8Array[]): Uint8Array => box('avc1', VISUAL(160, 90), ...children);

describe('aspectOf on hand-built boxes', () => {
  test('the last pasp with a non-zero vSpacing wins, as the mov demuxer reads every sample entry', () => {
    expect(ratio(aspectOf(isoTrack([avc1(pasp(4, 3)), avc1(pasp(16, 11))]))?.sampleAspectRatio)).toBe('16:11');
    expect(ratio(aspectOf(isoTrack([avc1(pasp(16, 11)), avc1(pasp(4, 3))]))?.sampleAspectRatio)).toBe('4:3');
    expect(ratio(aspectOf(isoTrack([avc1(pasp(4, 3)), avc1()]))?.sampleAspectRatio)).toBe('4:3');
    expect(ratio(aspectOf(isoTrack([avc1(pasp(4, 3), pasp(5, 0))]))?.sampleAspectRatio)).toBe('4:3');
  });

  test('a pasp of 0 or a negative value gives no container ratio, so the tkhd size or the VUI speaks', () => {
    const vui = avcC(h264Sps({ profile: 100, vui: { sar: [12, 11] } }));
    expect(ratio(aspectOf(isoTrack([avc1(vui, pasp(0, 1))]))?.sampleAspectRatio)).toBe('12:11');
    expect(ratio(aspectOf(isoTrack([avc1(vui, pasp(3, -1))]))?.sampleAspectRatio)).toBe('12:11');
    expect(ratio(aspectOf(isoTrack([avc1(vui, pasp(0, 1))], { tkhd: tkhd(320 << 16, 90 << 16) }))?.sampleAspectRatio)).toBe('2:1');
    expect(aspectOf(isoTrack([avc1(pasp(0, 0))]))?.sampleAspectRatio).toBeNull();
  });

  test('a pasp with a zero hSpacing replaces an earlier pasp but leaves the tkhd matrix ratio in place', () => {
    const scaled = [2 * 65536, 0, 0, 0, 65536, 0, 0, 0, 1 << 30];
    expect(ratio(aspectOf(isoTrack([avc1(pasp(0, 1))], { tkhd: tkhd(160 << 16, 90 << 16, scaled) }))?.sampleAspectRatio)).toBe('2:1');
    expect(ratio(aspectOf(isoTrack([avc1(pasp(4, 3)), avc1(pasp(0, 1))], { tkhd: tkhd(240 << 16, 90 << 16) }))?.sampleAspectRatio)).toBe('3:2');
    expect(ratio(aspectOf(isoTrack([avc1(pasp(4, 3)), avc1(pasp(1, 0))]))?.sampleAspectRatio)).toBe('4:3');
  });

  test('the tkhd size is a signed 16.16 value, so a size from 32768 on turns negative as in FFmpeg', () => {
    const t = isoTrack([avc1()], { tkhd: tkhd(65519 * 65536, 65521 * 65536), width: 65521, height: 65519 });
    expect(ratio(aspectOf(t)?.sampleAspectRatio)).toBe('1113823:982815');
  });

  test('the tkhd matrix, times the mvhd matrix, comes before the tkhd size and after the pasp', () => {
    const scaled = [2 * 65536, 0, 0, 0, 65536, 0, 0, 0, 1 << 30];
    expect(ratio(aspectOf(isoTrack([avc1()], { tkhd: tkhd(240 << 16, 90 << 16, scaled) }))?.sampleAspectRatio)).toBe('2:1');
    expect(ratio(aspectOf(isoTrack([avc1(pasp(4, 3))], { tkhd: tkhd(240 << 16, 90 << 16, scaled) }))?.sampleAspectRatio)).toBe('4:3');
    expect(ratio(aspectOf(isoTrack([avc1()], { mvhd: mvhd(scaled) }))?.sampleAspectRatio)).toBe('2:1');
    expect(ratio(aspectOf(isoTrack([avc1()], { tkhd: tkhd(240 << 16, 90 << 16, [65536 * 1.005, 0, 0, 0, 65536, 0, 0, 0, 1 << 30].map(Math.round)) }))?.sampleAspectRatio)).toBe('3:2');
    expect(aspectOf(isoTrack([avc1()], { tkhd: tkhd(0, 0, scaled) }))?.sampleAspectRatio).toBeNull();
    expect(ratio(aspectOf(isoTrack([avc1()], { tkhd: tkhd(160 << 16, 90 << 16, [0, 65536, 0, -65536, 0, 0, 0, 0, 1 << 30]) }))?.sampleAspectRatio)).toBeNull();
  });

  test('the display size applies the ratio to the width and the rotation swaps it', () => {
    const t = isoTrack([avc1(pasp(4, 3))], { width: 1440, height: 1080, rotation: 90 });
    expect(aspectOf(t)).toEqual({ sampleAspectRatio: { num: 4, den: 3, value: 4 / 3 }, displayAspectRatio: { num: 16, den: 9, value: 16 / 9 }, displayWidth: 1080, displayHeight: 1920 });
    expect(aspectOf({ ...t, rotation: 270 })?.displayWidth).toBe(1080);
    expect(aspectOf({ ...t, rotation: 180 })?.displayWidth).toBe(1920);
    expect(aspectOf({ ...t, width: 0 })).toMatchObject({ displayAspectRatio: null, displayWidth: null, displayHeight: null });
  });

  test('undefined without captured bytes, and withAspect drops the bytes unless asked to keep them', () => {
    expect(aspectOf({ codecName: 'h264', width: 1, height: 1, rotation: 0 })).toBeUndefined();
    const persisted = isoTrack([avc1(pasp(4, 3))]);
    expect(aspectOf({ ...persisted, codecConfig: JSON.parse(JSON.stringify(persisted.codecConfig)) as CodecConfig })).toBeUndefined();
    expect(aspectOf({ ...persisted, codecConfig: { family: 'isobmff', stsd: null, tkhd: null, mvhd: null } })).toBeUndefined();
    expect(aspectOf({ ...persisted, codecConfig: { family: 'matroska', trackEntry: null } })).toBeUndefined();
    const result = { videoTracks: [{ ...emptyTrack(1), ...isoTrack([avc1(pasp(4, 3))]) }] };
    expect(withAspect(result).videoTracks[0]).not.toHaveProperty('codecConfig');
    expect(withAspect(result, { keepCodecConfig: true }).videoTracks[0]).toHaveProperty('codecConfig');
    expect(withAspect(result).videoTracks[0].sampleAspectRatio).toEqual({ num: 4, den: 3, value: 4 / 3 });
  });
});

describe('the codec configuration analyzeHeader captures', () => {
  const SCALED = [2 * 65536, 0, 0, 0, 65536, 0, 0, 0, 1 << 30];
  const trak = (entry: Uint8Array): Uint8Array => {
    const stbl = box('stbl', fullBox('stsd', 0, 0, u32(1), entry), fullBox('stts', 0, 0, u32(1), u32(1), u32(512)), fullBox('stsz', 0, 0, u32(10), u32(1)), fullBox('stsc', 0, 0, u32(1), u32(1), u32(1), u32(1)), fullBox('stco', 0, 0, u32(1), u32(0)));
    const mdia = box('mdia', fullBox('mdhd', 0, 0, u32(0), u32(0), u32(15360), u32(512), u16(0x55c4), u16(0)), fullBox('hdlr', 0, 0, u32(0), tag('vide'), zeros(12), [0]), box('minf', stbl));
    return box('trak', tkhd(160 << 16, 90 << 16), mdia);
  };
  const file = (...moov: Uint8Array[]) => new Blob([bytes(ftyp(), box('moov', ...moov), mdatHeader(10), zeros(10))]);
  const header = async (blob: Blob) => (await analyzeHeader(blob, { aspect: true, codecConfig: true })).videoTracks[0];

  test('takes the mvhd known when the trak starts, so a later mvhd does not scale the tkhd matrix', async () => {
    expect(ratio((await header(file(mvhd(SCALED), trak(avc1()))))?.sampleAspectRatio)).toBe('2:1');
    const late = await header(file(trak(avc1()), mvhd(SCALED)));
    expect(late.codecConfig).toMatchObject({ mvhd: null });
    expect(late.sampleAspectRatio).toBeNull();
  });

  test('copies a sample description of any size, so a pasp after a large box still counts', async () => {
    const t = await header(file(mvhd(), trak(avc1(box('free', zeros(70000)), pasp(4, 3)))));
    expect(ratio(t.sampleAspectRatio)).toBe('4:3');
  });
});

describe('Matroska display elements', () => {
  const ID = { video: 0xe0, pixelWidth: 0xb0, pixelHeight: 0xba, displayWidth: 0x54b0, displayHeight: 0x54ba, displayUnit: 0x54b2, stereo: 0x53b8, cropTop: 0x54bb, cropBottom: 0x54aa, cropLeft: 0x54cc, cropRight: 0x54dd, projection: 0x7670, projectionType: 0x7671, yaw: 0x7673, pitch: 0x7674, roll: 0x7675 };
  const float = (id: number, v: number): Uint8Array => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, v);
    return ebml(id, b);
  };
  const mkv = (...video: Uint8Array[]) => ({ codecName: 'h264', width: 160, height: 120, rotation: 0, codecConfig: { family: 'matroska' as const, trackEntry: ebml(ID.video, uint(ID.pixelWidth, 160), uint(ID.pixelHeight, 120), ...video) } });
  test('units 0 to 3 apply the display size, a missing element takes the pixel size only with unit 0', () => {
    expect(ratio(aspectOf(mkv(uint(ID.displayWidth, 16), uint(ID.displayHeight, 9), uint(ID.displayUnit, 3)))?.sampleAspectRatio)).toBe('4:3');
    expect(ratio(aspectOf(mkv())?.sampleAspectRatio)).toBe('1:1');
    expect(aspectOf(mkv(uint(ID.displayWidth, 16), uint(ID.displayUnit, 2)))?.sampleAspectRatio).toBeNull();
    expect(aspectOf(mkv(uint(ID.displayWidth, 16), uint(ID.displayHeight, 9), uint(ID.displayUnit, 4)))?.sampleAspectRatio).toBeNull();
  });

  test('PixelCrop shrinks the size the ratio and the unit 0 defaults use, while the display size keeps the full width', () => {
    expect(aspectOf(mkv(uint(ID.displayWidth, 8), uint(ID.displayHeight, 5), uint(ID.displayUnit, 3), uint(ID.cropLeft, 8), uint(ID.cropRight, 8)))).toEqual({ sampleAspectRatio: { num: 4, den: 3, value: 4 / 3 }, displayAspectRatio: { num: 16, den: 9, value: 16 / 9 }, displayWidth: 213, displayHeight: 120 });
    expect(aspectOf(mkv(uint(ID.displayWidth, 16), uint(ID.displayHeight, 9), uint(ID.cropLeft, 16)))).toMatchObject({ sampleAspectRatio: { num: 40, den: 27 }, displayAspectRatio: { num: 160, den: 81 } });
    expect(ratio(aspectOf(mkv(uint(ID.cropTop, 20), uint(ID.cropBottom, 10)))?.sampleAspectRatio)).toBe('1:1');
    expect(aspectOf(mkv(uint(ID.displayWidth, 16), uint(ID.displayHeight, 9), uint(ID.cropLeft, 80), uint(ID.cropRight, 80)))?.sampleAspectRatio).toBeNull();
  });

  test('a repeated display element takes its last value and an empty one its default, as the EBML parser of FFmpeg reads them', () => {
    expect(ratio(aspectOf(mkv(uint(ID.displayWidth, 16), uint(ID.displayHeight, 9), uint(ID.displayWidth, 32)))?.sampleAspectRatio)).toBe('8:3');
    expect(ratio(aspectOf(mkv(ebml(ID.displayWidth, []), uint(ID.displayHeight, 9)))?.sampleAspectRatio)).toBe('40:3');
  });

  test('ProjectionPoseRoll rotates the display size as the display matrix of ffprobe does', () => {
    const rotated = (...pose: Uint8Array[]) => aspectOf(mkv(uint(ID.displayWidth, 16), uint(ID.displayHeight, 9), ebml(ID.projection, ...pose)));
    expect(rotated(float(ID.roll, 90))).toMatchObject({ displayWidth: 120, displayHeight: 213 });
    expect(rotated(float(ID.roll, -90))).toMatchObject({ displayWidth: 120, displayHeight: 213 });
    expect(rotated(float(ID.roll, 90), float(ID.yaw, 180))).toMatchObject({ displayWidth: 120, displayHeight: 213 });
    expect(rotated(float(ID.roll, 180))).toMatchObject({ displayWidth: 213, displayHeight: 120 });
    expect(rotated(float(ID.roll, 90), float(ID.pitch, 10))).toMatchObject({ displayWidth: 213, displayHeight: 120 });
    expect(rotated(float(ID.roll, 90), uint(ID.projectionType, 1))).toMatchObject({ displayWidth: 213, displayHeight: 120 });
  });

  test('a side by side stereo mode doubles the display width and a top and bottom mode the height', () => {
    expect(ratio(aspectOf(mkv(uint(ID.displayWidth, 320), uint(ID.displayHeight, 120), uint(ID.stereo, 1)))?.sampleAspectRatio)).toBe('4:1');
    expect(ratio(aspectOf(mkv(uint(ID.displayWidth, 160), uint(ID.displayHeight, 240), uint(ID.stereo, 3)))?.sampleAspectRatio)).toBe('1:4');
  });
});

describe('av_reduce', () => {
  test('reduces exactly within the bound and approximates beyond it as FFmpeg does', () => {
    expect(avReduce(640000n, 270009n, 1048576n)).toEqual([640000n, 270009n]);
    expect(avReduce(1920n * 4n, 1080n * 3n, 1048576n)).toEqual([64n, 27n]);
    expect(avReduce(2147483648n, 3n, 2147483647n)).toEqual([1431655765n, 2n]);
    expect(avReduce(-4n, 3n, 2147483647n)).toEqual([-4n, 3n]);
    const [num, den] = avReduce(3141592653n, 1000000000n, 1048576n);
    expect(num <= 1048576n && den <= 1048576n && Math.abs(Number(num) / Number(den) - 3.141592653) < 1e-9).toBe(true);
  });
});
