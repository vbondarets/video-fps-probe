import { openAsBlob } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { colorOf, withColor } from '../../src/color/index.ts';
import { analyze } from '../../src/core/analyze.ts';
import { FILES_DIR } from '../helpers/fixtures.ts';
import { ebml, h264Sps, hevcSps, text, uint } from './bits.ts';

const mkvColor = async (name: string) => {
  const r = await analyze(await openAsBlob(join(FILES_DIR, name)), name, { codecConfig: true });
  return withColor(r).videoTracks[0].color;
};

describe('color of the Matroska fixtures, as ffprobe 8.1.1 prints it', () => {
  test('hdr10_hevc10.mkv takes the Colour element and the hvcC CodecPrivate', async () => {
    expect(await mkvColor('hdr10_hevc10.mkv')).toEqual({ range: 'tv', primaries: 'bt2020', transfer: 'smpte2084', space: 'bt2020nc', source: 'Colour', bitDepth: 10, profile: 2, codecString: 'hvc1.2.4.L30.90', hdr: 'pq', dolbyVision: null });
  });

  test('dv_p81.mkv takes Dolby Vision from a BlockAdditionMapping', async () => {
    expect((await mkvColor('dv_p81.mkv'))?.dolbyVision).toEqual({ versionMajor: 1, versionMinor: 0, profile: 8, level: 1, rpu: true, el: false, bl: true, compatibilityId: 1, mdCompression: 1 });
  });

  test('vp9_p2_10bit.webm has the Colour element but no CodecPrivate', async () => {
    expect(await mkvColor('vp9_p2_10bit.webm')).toMatchObject({ primaries: 'bt2020', transfer: 'smpte2084', space: 'bt2020nc', source: 'Colour', bitDepth: null, profile: null, codecString: null });
  });

  test('without the option the result carries no codec configuration', async () => {
    const blob = await openAsBlob(join(FILES_DIR, 'hdr10_hevc10.mkv'));
    expect((await analyze(blob, 'a.mkv')).videoTracks[0]).not.toHaveProperty('codecConfig');
    expect((await analyze(blob, 'a.mkv', { codecConfig: true })).videoTracks[0].codecConfig?.family).toBe('matroska');
  });
});

const ID = { codecId: 0x86, codecPrivate: 0x63a2, video: 0xe0, colour: 0x55b0, matrix: 0x55b1, bits: 0x55b2, range: 0x55b9, transfer: 0x55ba, primaries: 0x55bb, mapping: 0x41e4, mappingType: 0x41e7, mappingData: 0x41ed };

function entry(...children: Uint8Array[]) {
  return { codecName: 'hevc', codecConfig: { family: 'matroska' as const, trackEntry: Uint8Array.from(children.flatMap((c) => [...c])) } };
}

function entryOf(codecName: string, ...children: Uint8Array[]) {
  return { ...entry(...children), codecName };
}

function h264Entry(sps: Uint8Array): Uint8Array[] {
  return [text(ID.codecId, 'V_MPEG4/ISO/AVC'), ebml(ID.codecPrivate, [1, 100, 0, 40, 0xff, 0xe1, sps.length >> 8, sps.length & 255, ...sps, 0])];
}

function hvcC(sps: Uint8Array): Uint8Array {
  const header = [1, 0x02, 0x20, 0, 0, 0, 0x90, 0, 0, 0, 0, 0, 93, 0xf0, 0, 0xfc, 0xfd, 0xfa, 0xfa, 0, 0, 0x0f, 1];
  return Uint8Array.from([...header, 0xa1, 0, 1, sps.length >> 8, sps.length & 255, ...sps]);
}

describe('colorOf on hand-built TrackEntry elements', () => {
  const sps = hevcSps({ vui: { fullRange: true, colour: [9, 18, 9] } });

  test('reserved Colour codes are dropped as FFmpeg drops them, so the SPS speaks', () => {
    const colour = ebml(ID.video, ebml(ID.colour, uint(ID.primaries, 3), uint(ID.transfer, 0), uint(ID.matrix, 3), uint(ID.range, 3)));
    expect(colorOf(entry(text(ID.codecId, 'V_MPEGH/ISO/HEVC'), ebml(ID.codecPrivate, hvcC(sps)), colour))).toMatchObject({ range: 'pc', primaries: 'bt2020', transfer: 'arib-std-b67', source: 'sps', bitDepth: 10, hdr: 'hlg' });
  });

  test('a matrix of 0 is gbr and a Colour range of 1 is tv, also over a full range SPS', () => {
    const colour = ebml(ID.video, ebml(ID.colour, uint(ID.matrix, 0), uint(ID.range, 1), uint(ID.bits, 12)));
    expect(colorOf(entry(text(ID.codecId, 'V_MPEGH/ISO/HEVC'), ebml(ID.codecPrivate, hvcC(sps)), colour))).toMatchObject({ range: 'tv', primaries: null, transfer: null, space: 'gbr', source: 'Colour', bitDepth: 10 });
    expect(colorOf(entry(text(ID.codecId, 'V_VP9'), colour))).toMatchObject({ range: 'tv', space: 'gbr', bitDepth: 12 });
  });

  test('Colour codes without an FFmpeg name still count as specified, as the Matroska demuxer keeps them', () => {
    const hlg = h264Entry(h264Sps({ profile: 100, vui: { fullRange: true, colour: [9, 18, 9] } }));
    const unnamed = ebml(ID.video, ebml(ID.colour, uint(ID.primaries, 13), uint(ID.transfer, 2), uint(ID.matrix, 2)));
    expect(colorOf(entryOf('h264', ...hlg, unnamed))).toMatchObject({ range: 'pc', primaries: null, transfer: null, space: null, source: 'Colour', hdr: null });
    const matrix = ebml(ID.video, ebml(ID.colour, uint(ID.matrix, 200)));
    expect(colorOf(entry(text(ID.codecId, 'V_MPEGH/ISO/HEVC'), ebml(ID.codecPrivate, hvcC(sps)), matrix))).toMatchObject({ primaries: null, transfer: null, space: null, source: 'Colour', hdr: null });
  });

  test('a repeated element inside Colour takes its last value and a second Colour is ignored, as the EBML parser of FFmpeg reads them', () => {
    const repeated = ebml(ID.video, ebml(ID.colour, uint(ID.primaries, 9), uint(ID.transfer, 18), uint(ID.matrix, 9), uint(ID.range, 1), uint(ID.transfer, 1), uint(ID.range, 2)));
    expect(colorOf(entry(text(ID.codecId, 'V_VP9'), repeated))).toMatchObject({ transfer: 'bt709', range: 'pc', hdr: null });
    const second = ebml(ID.video, ebml(ID.colour, uint(ID.primaries, 9), uint(ID.transfer, 18), uint(ID.matrix, 9)), ebml(ID.colour, uint(ID.primaries, 1), uint(ID.transfer, 1), uint(ID.matrix, 1)));
    expect(colorOf(entry(text(ID.codecId, 'V_VP9'), second))).toMatchObject({ primaries: 'bt2020', transfer: 'arib-std-b67', hdr: 'hlg' });
    const empty = ebml(ID.video, ebml(ID.colour, uint(ID.primaries, 9), ebml(ID.range, [])));
    expect(colorOf(entry(text(ID.codecId, 'V_VP9'), empty))).toMatchObject({ primaries: 'bt2020', range: null });
  });

  test('a CodecID padded to hundreds of kilobytes is read without spreading it', () => {
    const size = 300000;
    const codecId = Uint8Array.from([0x86, 0x10 | (size >>> 24), (size >>> 16) & 255, (size >>> 8) & 255, size & 255, ...[...'V_VP9'].map((c) => c.charCodeAt(0)), ...new Array<number>(size - 5).fill(0)]);
    const colour = ebml(ID.video, ebml(ID.colour, uint(ID.primaries, 9), uint(ID.transfer, 16), uint(ID.matrix, 9)));
    expect(colorOf(entry(codecId, colour))).toMatchObject({ transfer: 'smpte2084', hdr: 'pq' });
  });

  test('a VP9 CodecPrivate gives the profile, the depth and the codec string', () => {
    const features = Uint8Array.from([1, 1, 2, 2, 1, 31, 3, 1, 10, 4, 1, 1]);
    expect(colorOf(entry(text(ID.codecId, 'V_VP9'), ebml(ID.codecPrivate, features)))).toMatchObject({ profile: 2, bitDepth: 10, codecString: 'vp09.02.31.10' });
  });

  test('a dvcC mapping counts and a mapping of another type does not', () => {
    const record = [1, 0, (5 << 1) | 0, (6 << 3) | 0b101, 0 << 4, ...new Array(19).fill(0)];
    const dvcC = ebml(ID.mapping, uint(ID.mappingType, 0x64766343), ebml(ID.mappingData, record));
    const other = ebml(ID.mapping, uint(ID.mappingType, 0x6d766343), ebml(ID.mappingData, record));
    expect(colorOf(entry(text(ID.codecId, 'V_MPEGH/ISO/HEVC'), dvcC))?.dolbyVision).toEqual({ versionMajor: 1, versionMinor: 0, profile: 5, level: 6, rpu: true, el: false, bl: true, compatibilityId: 0, mdCompression: 0 });
    expect(colorOf(entry(text(ID.codecId, 'V_MPEGH/ISO/HEVC'), other))).toBeNull();
  });
});
