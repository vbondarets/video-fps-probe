import { openAsBlob } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { aspectOf, avReduce, withAspect } from '../../src/aspect/index.ts';
import { analyze } from '../../src/core/analyze.ts';
import { emptyTrack } from '../../src/core/result.ts';
import type { CodecConfig } from '../../src/core/types.ts';
import { analyzeHeader } from '../../src/header/index.ts';
import { ebml, h264Sps, uint } from '../color/bits.ts';
import { FILES_DIR } from '../helpers/fixtures.ts';
import { box, bytes, fullBox, u16, u32, zeros } from '../helpers/iso-builder.ts';

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

  test('undefined without a codec configuration, and withAspect drops the bytes unless asked to keep them', () => {
    expect(aspectOf({ codecName: 'h264', width: 1, height: 1, rotation: 0 })).toBeUndefined();
    const result = { videoTracks: [{ ...emptyTrack(1), ...isoTrack([avc1(pasp(4, 3))]) }] };
    expect(withAspect(result).videoTracks[0]).not.toHaveProperty('codecConfig');
    expect(withAspect(result, { keepCodecConfig: true }).videoTracks[0]).toHaveProperty('codecConfig');
    expect(withAspect(result).videoTracks[0].sampleAspectRatio).toEqual({ num: 4, den: 3, value: 4 / 3 });
  });
});

describe('Matroska display elements', () => {
  const ID = { video: 0xe0, pixelWidth: 0xb0, pixelHeight: 0xba, displayWidth: 0x54b0, displayHeight: 0x54ba, displayUnit: 0x54b2, stereo: 0x53b8 };
  const mkv = (...video: Uint8Array[]) => ({ codecName: 'h264', width: 160, height: 120, rotation: 0, codecConfig: { family: 'matroska' as const, trackEntry: ebml(ID.video, uint(ID.pixelWidth, 160), uint(ID.pixelHeight, 120), ...video) } });
  test('units 0 to 3 apply the display size, a missing element takes the pixel size only with unit 0', () => {
    expect(ratio(aspectOf(mkv(uint(ID.displayWidth, 16), uint(ID.displayHeight, 9), uint(ID.displayUnit, 3)))?.sampleAspectRatio)).toBe('4:3');
    expect(ratio(aspectOf(mkv())?.sampleAspectRatio)).toBe('1:1');
    expect(aspectOf(mkv(uint(ID.displayWidth, 16), uint(ID.displayUnit, 2)))?.sampleAspectRatio).toBeNull();
    expect(aspectOf(mkv(uint(ID.displayWidth, 16), uint(ID.displayHeight, 9), uint(ID.displayUnit, 4)))?.sampleAspectRatio).toBeNull();
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
