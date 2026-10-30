import { statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { expectedLayout, isoBmffFixtureSet, scanIsoBmffLayout, scanMatroskaLayout } from '../../scripts/compare/layout.ts';
import { fixturePath, loadManifest } from '../helpers/fixtures.ts';

async function videoTracks(name: string) {
  const path = fixturePath(name);
  if (!path) throw new Error(`${name} is missing`);
  const layout = await scanMatroskaLayout(path, statSync(path).size);
  return layout?.matroskaTracks?.filter((t) => t.type === 1) ?? null;
}

async function iso(name: string) {
  const path = fixturePath(name);
  if (!path) throw new Error(`${name} is missing`);
  const layout = await scanIsoBmffLayout(path, statSync(path).size);
  if (!layout) throw new Error(`${name} has no ISO BMFF layout`);
  return { layout, video: layout.tracks?.find((t) => t.handler === 'vide') ?? null };
}

describe('Matroska layout scan of the compare harness', () => {
  it('reads the DefaultDuration of a sized WebM', async () => {
    expect(await videoTracks('vp9.webm')).toMatchObject([{ number: 1, type: 1, defaultDurationNs: 33366666, blockDurations: 0 }]);
  });

  it('finds no DefaultDuration where an EBML Void replaced it', async () => {
    expect(await videoTracks('vp9_no_defaultduration.webm')).toMatchObject([{ number: 1, type: 1, defaultDurationNs: null, blockDurations: 0 }]);
  });

  it('walks the unknown-size Segment and Clusters of a chunked recording', async () => {
    expect(await videoTracks('rec_chromium_vp8_sliced.webm')).toMatchObject([{ number: 1, type: 1, defaultDurationNs: null, blockDurations: 0 }]);
  });

  it('counts the BlockDuration of every BlockGroup', async () => {
    expect(await videoTracks('h264_vfr_remux.mkv')).toMatchObject([{ number: 1, type: 1, defaultDurationNs: 23076923, blockDurations: 260 }]);
  });

  it('returns null for a file that is not Matroska', async () => {
    const path = fixturePath('cfr_h264_30.mp4');
    expect(path).not.toBeNull();
    expect(await scanMatroskaLayout(path!, statSync(path!).size)).toBeNull();
  });

  it('reads the display elements, the Colour element, the flags and the codec configuration', async () => {
    expect(await videoTracks('sar_4x3.mkv')).toMatchObject([{ codecId: 'V_MPEG4/ISO/AVC', pixelWidth: 160, pixelHeight: 120, displayWidth: 16, displayHeight: 9, displayUnit: 3, flagEnabled: true, flagDefault: false, config: { kind: 'avcC', profile: 66, constraints: 0xc0, bitDepth: 8, hasSps: true } }]);
    expect(await videoTracks('hdr10_hevc10.mkv')).toMatchObject([{ colour: { kind: 'Colour', primaries: 9, transfer: 16, matrix: 9, fullRange: false }, config: { kind: 'hvcC', profile: 2, bitDepth: 10, hasSps: true } }]);
    expect(await videoTracks('vp9_p2_10bit.webm')).toMatchObject([{ codecId: 'V_VP9', config: null, colour: { primaries: 9, transfer: 16 } }]);
    expect(await videoTracks('dv_p81.mkv')).toMatchObject([{ blockAdditionTypes: ['dvvC'] }]);
  });
});

describe('ISO BMFF layout scan of the compare harness', () => {
  it('finds the moov, the first mdat, mvex and a sidx before the first moof', async () => {
    expect((await iso('cfr_h264_30.mp4')).layout).toMatchObject({ moovOffset: 87638, moovSize: 1172, firstMdatOffset: 40, hasMvex: false, sidxBeforeFirstMoof: false });
    expect(expectedLayout((await iso('cfr_h264_30.mp4')).layout)).toEqual({ kind: 'moov-at-end', moovOffset: 87638, moovSize: 1172, sidx: false, emptyMoov: false });
    expect(expectedLayout((await iso('faststart_large_moov.mp4')).layout)).toEqual({ kind: 'faststart', moovOffset: 32, moovSize: 72831, sidx: false, emptyMoov: false });
    expect(expectedLayout((await iso('fmp4_global_sidx.mp4')).layout)).toMatchObject({ kind: 'fragmented', sidx: true, emptyMoov: true });
    expect(expectedLayout((await iso('fmp4_hybrid_no_empty_moov.mp4')).layout)).toMatchObject({ kind: 'fragmented', sidx: false, emptyMoov: false });
    expect(expectedLayout((await iso('corrupt_trunc_no_moov.mp4')).layout)).toEqual({ kind: 'moov-at-end', moovOffset: null, moovSize: null, sidx: false, emptyMoov: false });
  });

  it('reads the tkhd flags, size and matrix and the facts of the first video sample entry', async () => {
    expect((await iso('track_disabled.mp4')).video).toMatchObject({ enabled: false, tkhdWidth: 160, tkhdHeight: 90 });
    expect((await iso('sar_tkhd_only.mp4')).video).toMatchObject({ enabled: true, tkhdWidth: 240, tkhdHeight: 90, entry: { type: 'avc1', width: 160, height: 90, pasp: null } });
    expect((await iso('sar_matrix_scale.mp4')).video?.matrix).toEqual([131072, 0, 0, 0, 65536, 0, 0, 0, 1073741824]);
    expect((await iso('sar_pasp_only.mp4')).video?.entry?.pasp).toEqual({ num: 4, den: 3 });
    expect((await iso('colr_nclc.mov')).video?.entry?.colr).toEqual({ kind: 'nclc', primaries: 1, transfer: 1, matrix: 1, fullRange: null });
    expect((await iso('colr_vui_conflict.mp4')).video?.entry?.colr).toEqual({ kind: 'nclx', primaries: 9, transfer: 16, matrix: 9, fullRange: false });
    expect((await iso('vp9_p2_10bit.mp4')).video?.entry).toMatchObject({ vpcC: { kind: 'vpcC', primaries: 9, transfer: 16, matrix: 9, fullRange: false }, config: { kind: 'vpcC', profile: 2, bitDepth: 10 } });
    expect((await iso('av1_10bit.mp4')).video?.entry?.config).toEqual({ kind: 'av1C', profile: 0, constraints: null, bitDepth: 10, hasSps: null });
    expect((await iso('dv_p5_dvcc_dvh1.mp4')).video?.entry).toMatchObject({ type: 'dvh1', dolbyVision: 'dvcC', config: { kind: 'hvcC', profile: 2, bitDepth: 10, hasSps: true } });
    expect((await iso('mp4_bf_elst.mp4')).video?.entry?.config).toMatchObject({ kind: 'avcC', profile: 100, bitDepth: 8 });
  });

  it('computes the ISO BMFF fixture set by sniffing, not by extension', async () => {
    const names = loadManifest().filter((m) => m.committed).map((m) => m.name);
    const set = await isoBmffFixtureSet(names, fixturePath);
    for (const n of ['corrupt_empty_0byte.mp4', 'corrupt_garbage_random.mp4', 'corrupt_png_named.mp4', 'corrupt_text_named.mp4', 'sniff_webm_named_mp4.mp4']) expect(set).not.toContain(n);
    for (const n of ['sniff_mp4_named_webm.webm', 'sniff_mp4_named_mkv.mkv', 'mov_cmov.mov', 'faststart_large_moov.mp4', 'colr_nclc.mov']) expect(set).toContain(n);
    expect(set.length).toBe(names.filter((n) => /\.(mp4|mov|m4a)$/.test(n)).length - 5 + 2);
  });
});
