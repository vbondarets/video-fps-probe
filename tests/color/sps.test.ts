import { describe, expect, test } from 'vitest';
import { bitReader, parseH264Sps, parseHevcSps, unescapeRbsp } from '../../src/color/sps.ts';
import { BitWriter, escapeRbsp, h264Sps, hevcSps } from './bits.ts';

const PQ: [number, number, number] = [9, 16, 9];

describe('the RBSP reader', () => {
  test('emulation prevention bytes are removed', () => {
    expect([...unescapeRbsp(Uint8Array.from([0, 0, 3, 1, 0, 0, 3, 0, 0, 3]))]).toEqual([0, 0, 1, 0, 0, 0, 0]);
    expect([...unescapeRbsp(escapeRbsp(Uint8Array.from([0, 0, 0, 0, 1, 2, 0, 0, 2])))]).toEqual([0, 0, 0, 0, 1, 2, 0, 0, 2]);
  });

  test('exp-Golomb codes read back as written', () => {
    const w = new BitWriter();
    const values = [0, 1, 2, 7, 255, 65535, 4294967294];
    for (const v of values) w.ue(v);
    for (const v of [0, 1, -1, 17, -300]) w.se(v);
    const r = bitReader(w.rbsp());
    expect(values.map(() => r.ue())).toEqual(values);
    expect([0, 1, 2, 3, 4].map(() => r.se())).toEqual([0, 1, -1, 17, -300]);
  });

  test('a reader past the end or above a bound gives up', () => {
    expect(parseH264Sps(Uint8Array.from([0x67, 100, 0]))).toBeNull();
    expect(parseHevcSps(Uint8Array.from([0x42, 0x01, 0x01]))).toBeNull();
    const bad = new BitWriter().u(8, 100).u(8, 0).u(8, 40).ue(32);
    expect(parseH264Sps(Uint8Array.from([0x67, ...bad.rbsp()]))).toBeNull();
  });
});

describe('H.264 SPS', () => {
  test('High with a colour description, a full range and an extended SAR', () => {
    expect(parseH264Sps(h264Sps({ profile: 100, scaling: true, vui: { sar: [4, 3], fullRange: true, colour: PQ } }))).toEqual({ bitDepth: 8, vui: { sar: [4, 3], fullRange: true, colour: PQ } });
  });

  test('High 10 without a colour description', () => {
    expect(parseH264Sps(h264Sps({ profile: 110, bitDepth: 10, vui: { fullRange: false } }))).toEqual({ bitDepth: 10, vui: { sar: null, fullRange: false, colour: null } });
  });

  test('Constrained Baseline with a table SAR, POC type 1 and no video signal type', () => {
    expect(parseH264Sps(h264Sps({ profile: 66, constraints: 0xc0, pocType: 1, vui: { sar: 14 } }))).toEqual({ bitDepth: 8, vui: { sar: [4, 3], fullRange: null, colour: null } });
  });

  test('no VUI, and an unspecified or reserved SAR index', () => {
    expect(parseH264Sps(h264Sps({ profile: 77, pocType: 2, vui: null }))).toEqual({ bitDepth: 8, vui: null });
    expect(parseH264Sps(h264Sps({ profile: 77, vui: { sar: 0 } }))?.vui?.sar).toBeNull();
    expect(parseH264Sps(h264Sps({ profile: 77, vui: { sar: 17 } }))?.vui?.sar).toBeNull();
    expect(parseH264Sps(h264Sps({ profile: 77, vui: { sar: [0, 1] } }))?.vui?.sar).toBeNull();
  });

  test('codes without an FFmpeg name read as unspecified', () => {
    expect(parseH264Sps(h264Sps({ profile: 100, vui: { colour: [13, 19, 18] } }))?.vui?.colour).toEqual([2, 2, 2]);
    expect(parseH264Sps(h264Sps({ profile: 100, vui: { colour: [22, 0, 0] } }))?.vui?.colour).toEqual([22, 0, 0]);
  });

  test('luma and chroma depths that differ give up, as FFmpeg rejects them', () => {
    const w = new BitWriter().u(8, 110).u(8, 0).u(8, 40).ue(0).ue(1).ue(2).ue(0);
    expect(parseH264Sps(Uint8Array.from([0x67, ...w.rbsp()]))).toBeNull();
  });

  test('a cut SPS gives up rather than read the colour fields from padding', () => {
    const full = h264Sps({ profile: 100, vui: { sar: [4, 3], fullRange: true, colour: PQ } });
    for (let cut = 2; cut < full.length - 9; cut++) expect(parseH264Sps(full.subarray(0, cut)), `cut at ${cut}`).toBeNull();
  });
});

describe('HEVC SPS', () => {
  test('Main 10 with sub-layers, scaling lists, PCM, short-term and long-term pictures and a colour description', () => {
    const sps = hevcSps({ subLayers: 2, scaling: true, pcm: true, shortTermSets: true, longTerm: true, vui: { sar: 1, fullRange: false, colour: PQ } });
    expect(parseHevcSps(sps)).toEqual({ bitDepth: 10, vui: { sar: [1, 1], fullRange: false, colour: PQ } });
  });

  test('Main 10 without a colour description and without a VUI', () => {
    expect(parseHevcSps(hevcSps({ vui: { fullRange: true } }))).toEqual({ bitDepth: 10, vui: { sar: null, fullRange: true, colour: null } });
    expect(parseHevcSps(hevcSps({ profile: 1, bitDepth: 8, vui: null }))).toEqual({ bitDepth: 8, vui: null });
  });

  test('a cut SPS gives up', () => {
    const full = hevcSps({ subLayers: 3, scaling: true, shortTermSets: true, vui: { sar: [16, 11], colour: PQ } });
    for (let cut = 3; cut < full.length - 9; cut++) expect(parseHevcSps(full.subarray(0, cut)), `cut at ${cut}`).toBeNull();
  });
});
