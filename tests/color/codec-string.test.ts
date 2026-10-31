import { describe, expect, test } from 'vitest';
import { dolbyVisionString, isoConfigFacts, matroskaConfigFacts } from '../../src/color/codec-string.ts';
import type { SampleEntry } from '../../src/color/config.ts';
import { h264Sps, hevcSps } from './bits.ts';

function entryOf(type: string, box: string, payload: number[] | Uint8Array): { b: Uint8Array; entry: SampleEntry } {
  const b = Uint8Array.from(payload);
  return { b, entry: { type, children: [{ type: box, start: 0, end: b.length }] } };
}

const avcC = (profile: number, compat: number, level: number, sps: Uint8Array | null, extension: number[] = []): number[] => [1, profile, compat, level, 0xff, sps ? 0xe1 : 0xe0, ...(sps ? [sps.length >> 8, sps.length & 255, ...sps] : []), 0, ...extension];

describe('RFC 6381 codec strings, profiles and bit depths', () => {
  test('avcC: the three bytes in lowercase hex after the sample entry type', () => {
    const { b, entry } = entryOf('avc3', 'avcC', avcC(0x64, 0x00, 0x28, h264Sps({ profile: 100, bitDepth: 10, vui: null })));
    expect(isoConfigFacts('h264', b, entry)).toMatchObject({ profile: 100, bitDepth: 10, codecString: 'avc3.640028' });
    const baseline = entryOf('avc1', 'avcC', avcC(0x42, 0xc0, 0x1e, null));
    expect(isoConfigFacts('h264', baseline.b, baseline.entry)).toMatchObject({ profile: 66, bitDepth: 8, codecString: 'avc1.42c01e', sps: null });
  });

  test('avcC without an SPS: the High extension gives the depth, and none without it', () => {
    const ext = entryOf('avc1', 'avcC', avcC(0x6e, 0, 0x28, null, [0xfd, 0xfa, 0xfa, 0]));
    expect(isoConfigFacts('h264', ext.b, ext.entry)?.bitDepth).toBe(10);
    const bare = entryOf('avc1', 'avcC', avcC(0x6e, 0, 0x28, null));
    expect(isoConfigFacts('h264', bare.b, bare.entry)?.bitDepth).toBeNull();
  });

  test('hvcC: profile space, reversed compatibility flags, tier, level and the trimmed constraint bytes', () => {
    const sps = hevcSps({ vui: null });
    const hvcC = [1, 0x22 | 0x40, 0x60, 0, 0, 0, 0xb0, 0, 0, 0, 0x01, 0, 153, 0xf0, 0, 0xfc, 0xfd, 0xfa, 0xfa, 0, 0, 0x0f, 1, 0xa1, 0, 1, sps.length >> 8, sps.length & 255, ...sps];
    const { b, entry } = entryOf('hev1', 'hvcC', hvcC);
    expect(isoConfigFacts('hevc', b, entry)).toMatchObject({ profile: 2, bitDepth: 10, codecString: 'hev1.A2.6.H153.b0.0.0.0.1' });
    expect(isoConfigFacts('hevc', b, entry)?.sps).toEqual({ bitDepth: 10, vui: null });
  });

  test('hvcC: the SPS gives the depth, and a general_profile_idc of 0 takes the first compatibility flag', () => {
    const sps = hevcSps({ bitDepth: 10, vui: null });
    const hvcC = [1, 0x00, 0x20, 0, 0, 0, 0x90, 0, 0, 0, 0, 0, 93, 0xf0, 0, 0xfc, 0xfd, 0xf8, 0xf8, 0, 0, 0x0f, 1, 0xa1, 0, 1, sps.length >> 8, sps.length & 255, ...sps];
    const { b, entry } = entryOf('hvc1', 'hvcC', hvcC);
    expect(isoConfigFacts('hevc', b, entry)).toMatchObject({ profile: 2, bitDepth: 10, codecString: 'hvc1.0.4.L93.90' });
    const bare = entryOf('hvc1', 'hvcC', hvcC.slice(0, 23));
    expect(isoConfigFacts('hevc', bare.b, bare.entry)).toMatchObject({ profile: 2, bitDepth: 8, sps: null });
  });

  test('av1C and vpcC', () => {
    const av1 = entryOf('av01', 'av1C', [0x81, (2 << 5) | 13, 0x80 | 0x40 | 0x20, 0]);
    expect(isoConfigFacts('av1', av1.b, av1.entry)).toMatchObject({ profile: 2, bitDepth: 12, codecString: 'av01.2.13H.12' });
    const main = entryOf('av01', 'av1C', [0x81, 8, 0x40, 0]);
    expect(isoConfigFacts('av1', main.b, main.entry)).toMatchObject({ profile: 0, bitDepth: 10, codecString: 'av01.0.08M.10' });
    const vp9 = entryOf('vp09', 'vpcC', [1, 0, 0, 0, 0, 0, 0x82, 1, 1, 1, 0, 0]);
    expect(isoConfigFacts('vp9', vp9.b, vp9.entry)).toMatchObject({ profile: 0, bitDepth: 8, codecString: 'vp09.00.00.08' });
  });

  test('Matroska CodecPrivate uses the same rules with the base fourcc of the CodecID', () => {
    const b = Uint8Array.from(avcC(0x4d, 0x40, 0x1f, null));
    expect(matroskaConfigFacts('V_MPEG4/ISO/AVC', b, { start: 0, end: b.length })).toMatchObject({ profile: 77, codecString: 'avc1.4d401f' });
    expect(matroskaConfigFacts('V_MPEG4/ISO/AVC', b, null)).toBeNull();
    expect(matroskaConfigFacts('V_MS/VFW/FOURCC', b, { start: 0, end: b.length })).toBeNull();
  });

  test('Dolby Vision sample entries name the profile and the level', () => {
    expect(dolbyVisionString('dvh1', 5, 6)).toBe('dvh1.05.06');
    expect(dolbyVisionString('dvhe', 8, 10)).toBe('dvhe.08.10');
  });
});
