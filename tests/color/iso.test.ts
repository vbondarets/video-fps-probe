import { openAsBlob, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { isoBmffFixtureSet } from '../../scripts/compare/layout.ts';
import { colorOf, withColor, type ColorInfo } from '../../src/color/index.ts';
import { analyze } from '../../src/core/analyze.ts';
import type { CodecConfig, VideoTrackResult } from '../../src/core/types.ts';
import { analyzeHeader } from '../../src/header/index.ts';
import { FILES_DIR } from '../helpers/fixtures.ts';
import { box, bytes, fullBox, tag, u16, u32, zeros } from '../helpers/iso-builder.ts';
import { h264Sps } from './bits.ts';

const headerColor = async (name: string): Promise<ColorInfo | null | undefined> => (await analyzeHeader(await openAsBlob(join(FILES_DIR, name)), { name, color: true })).videoTracks[0]?.color;

const DV_81 = { versionMajor: 1, versionMinor: 0, profile: 8, level: 1, rpu: true, el: false, bl: true, compatibilityId: 1, mdCompression: 1 };
const DV_5 = { versionMajor: 1, versionMinor: 0, profile: 5, level: 2, rpu: true, el: false, bl: true, compatibilityId: 0, mdCompression: 0 };

const EXPECTED: Record<string, Partial<ColorInfo>> = {
  'colr_vui_conflict.mp4': { range: 'tv', primaries: 'bt2020', transfer: 'smpte2084', space: 'bt2020nc', source: 'colr', bitDepth: 8, profile: 66, codecString: 'avc1.42c015', hdr: 'pq', dolbyVision: null },
  'colr_vui_conflict_hevc.mp4': { range: 'tv', primaries: 'bt709', transfer: 'bt709', space: 'bt709', source: 'colr', bitDepth: 10, profile: 2, hdr: null },
  'colr_only_h264.mp4': { range: 'tv', primaries: 'bt2020', transfer: 'smpte2084', space: 'bt2020nc', source: 'colr', hdr: 'pq' },
  'colr_only_hevc.mp4': { range: 'tv', primaries: 'bt2020', transfer: 'smpte2084', space: 'bt2020nc', source: 'colr', bitDepth: 10, hdr: 'pq' },
  'colr_unspecified_hevc.mp4': { range: 'pc', primaries: 'bt2020', transfer: 'smpte2084', space: 'bt2020nc', source: 'sps', hdr: 'pq' },
  'colr_partial_h264.mp4': { range: 'pc', primaries: 'bt709', transfer: null, space: null, source: 'colr', hdr: null },
  'colr_nclc.mov': { range: 'pc', primaries: 'bt709', transfer: 'bt709', space: 'bt709', source: 'colr' },
  'hlg_vui_only.mp4': { range: 'tv', primaries: 'bt2020', transfer: 'arib-std-b67', space: 'bt2020nc', source: 'sps', bitDepth: 10, hdr: 'hlg' },
  'hlg_h264_vui_only.mp4': { range: 'tv', primaries: 'bt2020', transfer: 'arib-std-b67', space: 'bt2020nc', source: 'sps', bitDepth: 8, hdr: 'hlg' },
  'hlg_h264_8bit.mp4': { transfer: 'arib-std-b67', bitDepth: 8, hdr: 'hlg' },
  'hdr10_hevc10.mp4': { range: 'tv', primaries: 'bt2020', transfer: 'smpte2084', space: 'bt2020nc', bitDepth: 10, profile: 2, hdr: 'pq' },
  'vp9_p2_10bit.mp4': { range: 'tv', primaries: 'bt2020', transfer: 'smpte2084', space: 'bt2020nc', source: 'colr', bitDepth: 10, profile: 2, hdr: 'pq' },
  'av1_10bit.mp4': { range: null, primaries: null, transfer: null, space: null, source: null, bitDepth: 10, profile: 0, hdr: null },
  'dv_p81_dvvc.mp4': { transfer: 'smpte2084', bitDepth: 10, profile: 2, hdr: 'pq', dolbyVision: DV_81 },
  'dv_p5_dvcc_dvh1.mp4': { transfer: 'smpte2084', bitDepth: 10, codecString: 'dvh1.05.02', dolbyVision: DV_5 },
};

describe('color of the ISO BMFF fixtures, as ffprobe 8.1.1 prints it', () => {
  for (const [name, expected] of Object.entries(EXPECTED)) {
    test(name, async () => {
      expect(await headerColor(name)).toMatchObject(expected);
    });
  }
});

const AVC1_FIELDS = (): Uint8Array => bytes(zeros(6), u16(1), zeros(16), u16(160), u16(90), u32(0x480000), u32(0x480000), u32(0), u16(1), zeros(32), u16(24), u16(0xffff));

function stsdOf(...entries: Uint8Array[]): Uint8Array {
  return fullBox('stsd', 0, 0, u32(entries.length), ...entries);
}

function avcC(sps: Uint8Array | null, profile = 100): Uint8Array {
  return box('avcC', [1, profile, 0, 40, 0xff, sps ? 0xe1 : 0xe0], sps ? bytes(u16(sps.length), sps) : [], [0]);
}

const nclx = (p: number, t: number, m: number, full: boolean): Uint8Array => box('colr', tag('nclx'), u16(p), u16(t), u16(m), [full ? 0x80 : 0]);

function track(stsd: Uint8Array | null, codecName = 'h264'): Pick<VideoTrackResult, 'codecName' | 'codecConfig'> {
  return { codecName, codecConfig: { family: 'isobmff', stsd, tkhd: null, mvhd: null } };
}

const avc1 = (...children: Uint8Array[]): Uint8Array => box('avc1', AVC1_FIELDS(), ...children);

describe('colorOf on hand-built sample entries', () => {
  test('the SPS speaks only when the colr is silent, a code without a name counts as unspecified', () => {
    const sps = h264Sps({ profile: 100, vui: { fullRange: true, colour: [9, 18, 9] } });
    expect(colorOf(track(stsdOf(avc1(avcC(sps), nclx(1, 1, 1, false)))))).toMatchObject({ range: 'tv', primaries: 'bt709', source: 'colr', hdr: null });
    expect(colorOf(track(stsdOf(avc1(avcC(sps), nclx(2, 2, 2, false)))))).toMatchObject({ range: 'tv', primaries: 'bt2020', transfer: 'arib-std-b67', source: 'sps', hdr: 'hlg' });
    expect(colorOf(track(stsdOf(avc1(avcC(sps), nclx(200, 2, 2, false)))))).toMatchObject({ primaries: 'bt2020', source: 'sps' });
    expect(colorOf(track(stsdOf(avc1(avcC(sps), nclx(3, 2, 2, false)))))).toMatchObject({ primaries: 'reserved', transfer: null, space: null, source: 'colr' });
    expect(colorOf(track(stsdOf(avc1(avcC(sps)))))).toMatchObject({ range: 'pc', transfer: 'arib-std-b67', source: 'sps' });
  });

  test('a walker that runs out of bits falls back to the container values', () => {
    const sps = h264Sps({ profile: 100, vui: { fullRange: true, colour: [9, 18, 9] } });
    const cut = sps.subarray(0, sps.length - 12);
    expect(colorOf(track(stsdOf(avc1(avcC(cut), nclx(1, 13, 1, false)))))).toMatchObject({ range: 'tv', primaries: 'bt709', transfer: 'iec61966-2-1', space: 'bt709', source: 'colr', bitDepth: null, profile: 100 });
    expect(colorOf(track(stsdOf(avc1(avcC(cut)))))).toMatchObject({ range: null, primaries: null, transfer: null, space: null, source: null });
    const nclc = box('colr', tag('nclc'), u16(1), u16(1), u16(1));
    expect(colorOf(track(stsdOf(avc1(avcC(cut), nclc))))).toMatchObject({ range: null, primaries: 'bt709', source: 'colr' });
  });

  test('the last colr or vpcC of the last sample entry gives the codes, as the mov demuxer overwrites them in order', () => {
    expect(colorOf(track(stsdOf(avc1(nclx(1, 1, 1, false), nclx(9, 16, 9, true))), 'mpeg4'))).toMatchObject({ range: 'pc', primaries: 'bt2020', source: 'colr' });
    expect(colorOf(track(stsdOf(avc1(nclx(9, 16, 9, true)), avc1(nclx(1, 1, 1, false))), 'mpeg4'))).toMatchObject({ range: 'tv', primaries: 'bt709' });
    const vpcC = fullBox('vpcC', 1, 0, [2, 31, 0xa1, 1, 1, 1], u16(0));
    expect(colorOf(track(stsdOf(box('vp09', AVC1_FIELDS(), nclx(9, 16, 9, false), vpcC)), 'vp9'))).toMatchObject({ range: 'pc', primaries: 'bt709', source: 'vpcC', bitDepth: 10, profile: 2, codecString: 'vp09.02.31.10' });
  });

  test('undefined without a codec configuration, null when the configuration holds nothing that colorOf reads', () => {
    expect(colorOf({ codecName: 'h264' })).toBeUndefined();
    expect(colorOf(track(null))).toBeNull();
    expect(colorOf(track(stsdOf()))).toBeNull();
    expect(colorOf(track(stsdOf(box('mp4v', AVC1_FIELDS())), 'mpeg4'))).toBeNull();
    expect(colorOf(track(Uint8Array.from([0, 0, 0, 9, 0x73, 0x74])))).toBeNull();
    const config: CodecConfig = { family: 'matroska', trackEntry: null };
    expect(colorOf({ codecName: 'h264', codecConfig: config })).toBeNull();
  });
});

describe('withColor', () => {
  test('leaves color undefined on a track without codecConfig, sets null on a configuration without a source and drops the bytes', async () => {
    const blob = await openAsBlob(join(FILES_DIR, 'cfr_h264_29.97.mp4'));
    const plain = await analyze(blob, 'a.mp4');
    expect(withColor(plain).videoTracks[0]).not.toHaveProperty('color');
    const raw = await analyzeHeader(blob, { codecConfig: true });
    const empty = { ...raw, videoTracks: raw.videoTracks.map((t) => ({ ...t, codecConfig: { family: 'isobmff' as const, stsd: null, tkhd: null, mvhd: null } })) };
    expect(withColor(empty).videoTracks[0].color).toBeNull();
    expect(withColor(raw).videoTracks[0]).not.toHaveProperty('codecConfig');
    expect(withColor(raw, { keepCodecConfig: true }).videoTracks[0].codecConfig).toEqual(raw.videoTracks[0].codecConfig);
    expect(raw.videoTracks[0].color).toBeUndefined();
  });
});

const names = readdirSync(FILES_DIR).sort();
const iso = await isoBmffFixtureSet(names, (n) => join(FILES_DIR, n));

describe('analyzeHeader with color equals withColor over analyzeHeader with codecConfig', () => {
  test(`on every fixture of the computed ISO BMFF set (${iso.length} files)`, async () => {
    expect(iso.length).toBeGreaterThan(100);
    for (const name of iso) {
      const blob = await openAsBlob(join(FILES_DIR, name));
      const viaOption = await analyzeHeader(blob, { name, color: true });
      const viaEntry = withColor(await analyzeHeader(blob, { name, codecConfig: true }));
      expect({ ...viaOption, io: null }, name).toEqual({ ...viaEntry, io: null });
      const plain = await analyzeHeader(blob, { name });
      expect(
        viaOption.videoTracks.map((t) => {
          const copy = { ...t };
          delete copy.color;
          return copy;
        }),
        name,
      ).toEqual(plain.videoTracks);
    }
  });
});
