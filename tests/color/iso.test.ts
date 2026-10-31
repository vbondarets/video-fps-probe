import { openAsBlob, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { isoBmffFixtureSet } from '../../scripts/compare/layout.ts';
import { aspectOf } from '../../src/aspect/index.ts';
import { isoConfig } from '../../src/color/config.ts';
import { colorOf, withColor, type ColorInfo } from '../../src/color/index.ts';
import { analyze } from '../../src/core/analyze.ts';
import { isoBoxes } from '../../src/core/isobmff/config.ts';
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

  test('SPS codes without an FFmpeg name read as unspecified, as the H.264 and HEVC decoders read them', () => {
    const sps = h264Sps({ profile: 100, vui: { fullRange: true, colour: [13, 19, 18] } });
    expect(colorOf(track(stsdOf(avc1(avcC(sps)))))).toMatchObject({ range: 'pc', primaries: null, transfer: null, space: null, source: null });
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

  test('undefined without captured bytes, null when the bytes hold nothing that colorOf reads', () => {
    expect(colorOf({ codecName: 'h264' })).toBeUndefined();
    expect(colorOf(track(null))).toBeUndefined();
    expect(colorOf(track(JSON.parse(JSON.stringify(stsdOf(avc1(nclx(9, 16, 9, false)))))))).toBeUndefined();
    expect(colorOf(track(stsdOf()))).toBeNull();
    expect(colorOf(track(stsdOf(box('mp4v', AVC1_FIELDS())), 'mpeg4'))).toBeNull();
    expect(colorOf(track(Uint8Array.from([0, 0, 0, 9, 0x73, 0x74])))).toBeNull();
    const config: CodecConfig = { family: 'matroska', trackEntry: null };
    expect(colorOf({ codecName: 'h264', codecConfig: config })).toBeUndefined();
  });

  test('a later nclc keeps the range of an earlier nclx or vpcC, as it has no range of its own', () => {
    const sps = h264Sps({ profile: 100, vui: { fullRange: true, colour: [1, 1, 1] } });
    const nclc = box('colr', tag('nclc'), u16(1), u16(1), u16(1));
    expect(colorOf(track(stsdOf(avc1(avcC(sps), nclx(9, 16, 9, false), nclc))))).toMatchObject({ range: 'tv', primaries: 'bt709', source: 'colr' });
    const vpcC = fullBox('vpcC', 1, 0, [2, 31, 0xa1, 1, 1, 1], u16(0));
    expect(colorOf(track(stsdOf(box('vp09', AVC1_FIELDS(), vpcC, nclc)), 'vp9'))).toMatchObject({ range: 'pc', primaries: 'bt709', source: 'colr' });
  });

  test('sample entries of another type than the first are skipped, as the mov demuxer skips them', () => {
    const hlg = avc1(nclx(9, 18, 9, false));
    const sdr = box('avc3', AVC1_FIELDS(), nclx(1, 1, 1, false));
    expect(colorOf(track(stsdOf(hlg, sdr)))).toMatchObject({ primaries: 'bt2020', transfer: 'arib-std-b67', hdr: 'hlg' });
    expect(colorOf(track(stsdOf(hlg, sdr, avc1(nclx(1, 1, 1, false)))))).toMatchObject({ primaries: 'bt709', hdr: null });
    const prores = (type: string, ...children: Uint8Array[]): Uint8Array => box(type, AVC1_FIELDS(), ...children);
    expect(colorOf(track(stsdOf(prores('apcn'), prores('apch', nclx(1, 1, 1, false))), 'prores'))).toMatchObject({ primaries: 'bt709' });
  });
});

describe('withColor', () => {
  test('leaves color undefined on a track without captured bytes, sets null on a configuration without a source and drops the bytes', async () => {
    const blob = await openAsBlob(join(FILES_DIR, 'cfr_h264_29.97.mp4'));
    const plain = await analyze(blob, 'a.mp4');
    expect(withColor(plain).videoTracks[0]).not.toHaveProperty('color');
    const raw = await analyzeHeader(blob, { codecConfig: true });
    const empty = { ...raw, videoTracks: raw.videoTracks.map((t) => ({ ...t, codecConfig: { family: 'isobmff' as const, stsd: null, tkhd: null, mvhd: null } })) };
    expect(withColor(empty).videoTracks[0].color).toBeUndefined();
    const none = { ...raw, videoTracks: raw.videoTracks.map((t) => ({ ...t, codecConfig: { family: 'isobmff' as const, stsd: stsdOf(), tkhd: null, mvhd: null } })) };
    expect(withColor(none).videoTracks[0].color).toBeNull();
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

function childrenOf(moovBytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  const dv = new DataView(moovBytes.buffer, moovBytes.byteOffset, moovBytes.byteLength);
  for (let p = 8; p + 8 <= moovBytes.length; ) {
    const size = dv.getUint32(p);
    out.push(moovBytes.subarray(p, p + size));
    p += size;
  }
  return out;
}

async function fixtureMoov(name: string): Promise<Uint8Array> {
  const blob = await openAsBlob(join(FILES_DIR, name));
  const { moovOffset, moovSize } = (await analyze(blob, name)).layout ?? {};
  return new Uint8Array(await blob.slice(moovOffset ?? 0, (moovOffset ?? 0) + (moovSize ?? 0)).arrayBuffer());
}

function viewOf(moovBytes: Uint8Array): DataView {
  const padded = new Uint8Array(moovBytes.length + 11);
  padded.set(moovBytes, 7);
  return new DataView(padded.buffer, 7, moovBytes.length);
}

function expectSameCut(moovBytes: Uint8Array, trak: number, label: string): ColorInfo | null | undefined {
  const dv = viewOf(moovBytes);
  const viewForm: CodecConfig = { family: 'isobmff', moov: dv, trak };
  const boxForm = isoBoxes(dv, trak);
  expect(isoConfig(viewForm), label).toEqual(isoConfig(boxForm));
  const track = (codecConfig: CodecConfig) => ({ codecName: 'h264', width: 320, height: 240, rotation: 0, codecConfig });
  expect(aspectOf(track(viewForm)), label).toEqual(aspectOf(track(boxForm)));
  const color = colorOf(track(viewForm));
  expect(color, label).toEqual(colorOf(track(boxForm)));
  return color;
}

describe('colorOf and aspectOf on a view of the moov, as the probes capture it', () => {
  test('cut the boxes analyzeHeader copies, from a view inside a larger buffer', async () => {
    const moovBytes = await fixtureMoov('colr_only_h264.mp4');
    expect(expectSameCut(moovBytes, 0, 'trak 0')).toEqual(await headerColor('colr_only_h264.mp4'));
    expect(expectSameCut(moovBytes, 1, 'a trak index past the last trak')).toBeUndefined();
  });

  test('pick the trak by its index among the trak boxes and the mvhd before it', async () => {
    const children = childrenOf(await fixtureMoov('colr_only_h264.mp4'));
    const trakAt = children.findIndex((c) => String.fromCharCode(...c.subarray(4, 8)) === 'trak');
    const other = childrenOf(await fixtureMoov('hdr10_hevc10.mp4')).find((c) => String.fromCharCode(...c.subarray(4, 8)) === 'trak')!;
    const two = box('moov', ...children.slice(0, trakAt + 1), other, ...children.slice(trakAt + 1));
    expect(expectSameCut(two, 0, 'first trak')?.transfer).toBe('smpte2084');
    expect(expectSameCut(two, 1, 'second trak')).not.toBeUndefined();
  });

  test('read box headers as the parser of the full walk reads them', async () => {
    const children = childrenOf(await fixtureMoov('colr_only_h264.mp4'));
    const trakAt = children.findIndex((c) => String.fromCharCode(...c.subarray(4, 8)) === 'trak');
    const before = (extra: Uint8Array) => box('moov', ...children.slice(0, trakAt), extra, ...children.slice(trakAt));
    expect(expectSameCut(before(box('uuid', zeros(8))), 0, 'a uuid box shorter than its 24 byte header stops the walk')).toBeUndefined();
    expect(expectSameCut(before(box('uuid', zeros(16))), 0, 'a uuid box with its 24 byte header')).not.toBeUndefined();
    expect(expectSameCut(before(bytes(u32(1), tag('free'), u32(0), u32(24), zeros(8))), 0, 'a 64-bit size')).not.toBeUndefined();
    expect(expectSameCut(before(bytes(u32(1), tag('free'), u32(1), u32(0), zeros(8))), 0, 'a 64-bit size past the moov')).toBeUndefined();
    expect(expectSameCut(before(bytes(u32(4), tag('free'))), 0, 'a size below the header')).toBeUndefined();
  });

  test('a view that does not survive a JSON round trip gives undefined', async () => {
    const moovBytes = await fixtureMoov('colr_only_h264.mp4');
    const config = JSON.parse(JSON.stringify({ family: 'isobmff', moov: viewOf(moovBytes), trak: 0 })) as CodecConfig;
    expect(colorOf({ codecName: 'h264', codecConfig: config })).toBeUndefined();
    expect(aspectOf({ codecName: 'h264', width: 320, height: 240, rotation: 0, codecConfig: config })).toBeUndefined();
  });
});
