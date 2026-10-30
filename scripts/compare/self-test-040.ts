import { statSync } from 'node:fs';
import type { FileResult, Rational, VideoTrackResult } from '../../src/core/types.ts';
import { expectedLayout, scanIsoBmffLayout, scanMatroskaLayout } from './layout.ts';
import { PROFILE_NOT_READ, PROFILE_TABLE, ffmpegProfileName, profileNamesOf } from './profiles.ts';
import { bitDepthOfPixFmt, parseColonRatio, parseRef, type RefFile, type RefStream } from './ref.ts';
import { BITSTREAM_COLOR, BITSTREAM_SAR, evaluate, matroskaTrackOf, type EvaluateInput, type Evaluation } from './rules.ts';
import { loadManifest, loadRef } from '../../tests/helpers/fixtures.ts';
import type { CheckResult, ColorLike, FileFields040, FileLayout, FixtureInfo, LayoutTrack, MatroskaLayoutTrack, SampleEntryFacts, TrackFields040 } from './types.ts';

type ExpectEq = (label: string, actual: unknown, expected: unknown) => void;

export interface SelfTestKit {
  refStream: (over?: Partial<RefStream>) => RefStream;
  refFile: (streams: RefStream[], over?: Partial<RefFile>) => RefFile;
  appTrack: (over?: Partial<VideoTrackResult>) => VideoTrackResult;
  appResult: (tracks: VideoTrackResult[], over?: Partial<FileResult>) => FileResult;
  rat: (num: number, den: number) => Rational;
  MP4_INFO: FixtureInfo;
  MKV_INFO: FixtureInfo;
}

const all = (e: Evaluation): CheckResult[] => [...e.fileChecks, ...e.tracks.flatMap((t) => t.checks)];
const find = (e: Evaluation, id: string): CheckResult | undefined => all(e).find((c) => c.id === id);
const verdict = (e: Evaluation, id: string): string => find(e, id)?.verdict ?? 'missing';

const NO_COLOR: ColorLike = { range: null, primaries: null, transfer: null, space: null, bitDepth: null, profile: null, codecString: null, dolbyVision: null };

function entry(over: Partial<SampleEntryFacts> = {}): SampleEntryFacts {
  return { type: 'avc1', width: 160, height: 90, pasp: null, colr: null, vpcC: null, config: null, dolbyVision: null, ...over };
}

function isoLayout(track: Partial<LayoutTrack> = {}, over: Partial<FileLayout> = {}): FileLayout {
  const t: LayoutTrack = { id: 1, handler: 'vide', mediaDurationSec: 3.003, samples: 90, hasEditList: false, enabled: true, tkhdWidth: 160, tkhdHeight: 90, matrix: [65536, 0, 0, 0, 65536, 0, 0, 0, 1 << 30], entry: entry(), ...track };
  return { fragmented: false, hasSidx: false, topLevel: ['ftyp', 'free', 'mdat', 'moov'], tracks: [t], hasMvex: false, moovOffset: 1000, moovSize: 500, firstMdatOffset: 40, sidxBeforeFirstMoof: false, ...over };
}

function mkvLayout(track: Partial<MatroskaLayoutTrack> = {}): FileLayout {
  return { fragmented: false, hasSidx: false, topLevel: [], matroskaTracks: [{ number: 1, type: 1, defaultDurationNs: 33366666, blockDurations: 0, flagEnabled: true, flagDefault: true, config: null, colour: null, ...track }] };
}

export function selfTest040(expectEq: ExpectEq, kit: SelfTestKit): void {
  const { refStream, refFile, appTrack, appResult, rat, MP4_INFO, MKV_INFO } = kit;
  const run = (input: Partial<EvaluateInput> & Pick<EvaluateInput, 'info' | 'ref' | 'result'>): Evaluation => evaluate(input);
  const track = (fields: TrackFields040, over: Partial<VideoTrackResult> = {}): VideoTrackResult => ({ ...appTrack(over), ...fields }) as VideoTrackResult;
  const mp4 = (fields: TrackFields040, stream: Partial<RefStream> = {}, layout: FileLayout | null = null, over: Partial<VideoTrackResult> = {}, file: Partial<FileResult> = {}) =>
    run({ info: MP4_INFO, ref: refFile([refStream(stream)]), result: appResult([track(fields, over)], { scan: 'exact', ...file }), layout });

  expectEq('ref: colon ratio', JSON.stringify(parseColonRatio('4:3')), '{"num":4,"den":3}');
  expectEq('ref: N/A ratio is none', parseColonRatio('N/A'), null);
  expectEq('ref: 0:1 ratio is none', parseColonRatio('0:1'), null);
  expectEq('ref: 10-bit pix_fmt', bitDepthOfPixFmt('yuv420p10le'), 10);
  expectEq('ref: 8-bit full range pix_fmt', bitDepthOfPixFmt('yuvj420p'), 8);
  expectEq('ref: rgb24 is 8 bits per component', bitDepthOfPixFmt('rgb24'), 8);
  expectEq('ref: p010le is 10 bits', bitDepthOfPixFmt('p010le'), 10);
  const parsed = parseRef('dv.mp4', {
    ok: true,
    probe: {
      format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '1.0' },
      streams: [
        {
          index: 0,
          codec_type: 'video',
          codec_name: 'hevc',
          profile: 'Main 10',
          time_base: '1/30000',
          sample_aspect_ratio: '4:3',
          display_aspect_ratio: '64:27',
          pix_fmt: 'yuv420p10le',
          color_range: 'tv',
          color_space: 'bt2020nc',
          color_transfer: 'smpte2084',
          color_primaries: 'unknown',
          disposition: { default: 0 },
          side_data_list: [
            { side_data_type: 'DOVI configuration record', dv_version_major: 1, dv_version_minor: 0, dv_profile: 8, dv_level: 1, rpu_present_flag: 1, el_present_flag: 0, bl_present_flag: 1, dv_bl_signal_compatibility_id: 1, dv_md_compression: 'limited' },
            { side_data_type: 'Display Matrix', displaymatrix: '', rotation: -90, extra_key: 1 },
            { side_data_type: 'Mastering display metadata' },
          ],
        },
      ],
    },
  });
  const ps = parsed.videoStreams[0];
  expectEq('ref: SAR', JSON.stringify(ps.sampleAspectRatio), '{"num":4,"den":3}');
  expectEq('ref: unknown primaries are none', ps.colorPrimaries, null);
  expectEq('ref: transfer name kept', ps.colorTransfer, 'smpte2084');
  expectEq('ref: disposition default 0', ps.enabled, false);
  expectEq('ref: Dolby Vision record mapped', JSON.stringify(ps.dolbyVision), '{"versionMajor":1,"versionMinor":0,"profile":8,"level":1,"rpu":true,"el":false,"bl":true,"compatibilityId":1,"mdCompression":1}');
  expectEq('ref: rotation of the display matrix', ps.rotation, -90);
  expectEq('ref: an unknown side data key and type are reported', ps.unmappedSideData.join(' | '), 'Display Matrix.extra_key | side data type "Mastering display metadata"');

  const cfr = mp4({});
  expectEq('not provided: no medianFrameInterval check', verdict(cfr, 'medianFrameInterval'), 'missing');
  expectEq('not provided: no color check', verdict(cfr, 'colorPrimaries'), 'missing');
  expectEq('not provided: no layout check', verdict(cfr, 'layout'), 'missing');

  expectEq('median: equal', verdict(mp4({ medianFrameInterval: rat(1001, 30000) }), 'medianFrameInterval'), 'exact');
  expectEq('median: off by a tick', verdict(mp4({ medianFrameInterval: rat(1002, 30000) }), 'medianFrameInterval'), 'mismatch');
  expectEq('median: header scan is n/a', verdict(mp4({ medianFrameInterval: null }, {}, null, {}, { scan: 'header' }), 'medianFrameInterval'), 'n/a');
  const twoFrames = { packets: { ...refStream().packets!, medianDeltaTicks: null, instFpsExcludingTail: null, ptsPresented: [0, 1001] } };
  expectEq('median: tail kept below 2 deltas', verdict(mp4({ medianFrameInterval: rat(1001, 30000) }, twoFrames), 'medianFrameInterval'), 'within-tol');
  expectEq('median: one frame, both none', verdict(mp4({ medianFrameInterval: null }, { packets: { ...refStream().packets!, medianDeltaTicks: null } }), 'medianFrameInterval'), 'exact');

  const sar = (fields: TrackFields040, ff: string | null, layout: FileLayout | null = isoLayout()) => mp4(fields, { sampleAspectRatio: parseColonRatio(ff), displayAspectRatio: null }, layout);
  expectEq('sar: equal', verdict(sar({ sampleAspectRatio: { num: 4, den: 3 } }, '4:3'), 'sampleAspectRatio'), 'exact');
  expectEq('sar: different', verdict(sar({ sampleAspectRatio: { num: 2, den: 1 } }, '3:2'), 'sampleAspectRatio'), 'mismatch');
  expectEq('sar: none against N/A', verdict(sar({ sampleAspectRatio: null }, 'N/A'), 'sampleAspectRatio'), 'exact');
  expectEq('sar: none against 1:1', verdict(sar({ sampleAspectRatio: null }, '1:1'), 'sampleAspectRatio'), 'exact');
  const vui = find(sar({ sampleAspectRatio: null }, '4:3'), 'sampleAspectRatio');
  expectEq('sar: none against a VUI ratio is a built-in deviation', `${vui?.verdict} ${vui?.deviation}`, `known-deviation ${BITSTREAM_SAR}`);
  expectEq('sar: none against a pasp ratio', verdict(sar({ sampleAspectRatio: null }, '4:3', isoLayout({ entry: entry({ pasp: { num: 4, den: 3 } }) })), 'sampleAspectRatio'), 'mismatch');
  expectEq('sar: none against a tkhd size ratio', verdict(sar({ sampleAspectRatio: null }, '3:2', isoLayout({ tkhdWidth: 240 })), 'sampleAspectRatio'), 'mismatch');
  expectEq('sar: none against a matrix ratio', verdict(sar({ sampleAspectRatio: null }, '2:1', isoLayout({ matrix: [131072, 0, 0, 0, 65536, 0, 0, 0, 1 << 30] })), 'sampleAspectRatio'), 'mismatch');
  expectEq('sar: a 1 percent matrix scale declares nothing', verdict(sar({ sampleAspectRatio: null }, '4:3', isoLayout({ matrix: [65864, 0, 0, 0, 65536, 0, 0, 0, 1 << 30] })), 'sampleAspectRatio'), 'known-deviation');
  expectEq('sar: none against a ratio without a scan', verdict(sar({ sampleAspectRatio: null }, '4:3', null), 'sampleAspectRatio'), 'mismatch');
  const mkvSar = (fields: TrackFields040, ff: string, layout: FileLayout) =>
    run({ info: MKV_INFO, ref: refFile([refStream({ sampleAspectRatio: parseColonRatio(ff) })], { formatName: 'matroska,webm' }), result: appResult([track(fields)], { container: 'webm', scan: 'exact' }), layout });
  expectEq('sar: Matroska Display elements declare a ratio', verdict(mkvSar({ sampleAspectRatio: null }, '4:3', mkvLayout({ displayWidth: 16, displayHeight: 9, displayUnit: 3 })), 'sampleAspectRatio'), 'mismatch');
  expectEq('sar: Matroska without Display elements', verdict(mkvSar({ sampleAspectRatio: null }, '4:3', mkvLayout()), 'sampleAspectRatio'), 'known-deviation');

  const dar = (fields: TrackFields040, ff: string | null) => mp4(fields, { width: 160, height: 120, sampleAspectRatio: parseColonRatio('4:3'), displayAspectRatio: parseColonRatio(ff) }, isoLayout(), { width: 160, height: 120 });
  expectEq('dar: 4:3 pixels on 160x120', verdict(dar({ sampleAspectRatio: { num: 4, den: 3 }, displayWidth: 213, displayHeight: 120 }, '16:9'), 'displayAspectRatio'), 'exact');
  expectEq('dar: a display width that is not round(width x SAR)', verdict(dar({ sampleAspectRatio: { num: 4, den: 3 }, displayWidth: 214, displayHeight: 120 }, '16:9'), 'displayAspectRatio'), 'mismatch');
  expectEq('dar: another ratio', verdict(dar({ sampleAspectRatio: { num: 1, den: 1 }, displayWidth: 160, displayHeight: 120 }, '16:9'), 'displayAspectRatio'), 'mismatch');
  expectEq('dar: none on both sides', verdict(dar({ sampleAspectRatio: null, displayWidth: 160, displayHeight: 120 }, null), 'displayAspectRatio'), 'exact');

  const disabled = isoLayout({ enabled: false });
  expectEq('enabled: equal to the tkhd flag', verdict(mp4({ enabled: false }, {}, disabled), 'enabled'), 'exact');
  expectEq('enabled: against the tkhd flag', verdict(mp4({ enabled: true }, {}, disabled), 'enabled'), 'mismatch');
  expectEq('enabled: no scan is n/a', verdict(mp4({ enabled: true }), 'enabled'), 'n/a');

  const pq = { colorRange: 'tv', colorPrimaries: 'bt2020', colorTransfer: 'smpte2084', colorSpace: 'bt2020nc' };
  const color = (c: Partial<ColorLike>, stream: Partial<RefStream>, layout: FileLayout | null, codecName = 'h264') => mp4({ color: { ...NO_COLOR, ...c } }, { codecName, ...stream }, layout, { codecName });
  expectEq('color: equal names', verdict(color({ range: 'tv', primaries: 'bt2020', transfer: 'smpte2084', space: 'bt2020nc' }, pq, isoLayout()), 'colorTransfer'), 'exact');
  expectEq('color: a wrong name', verdict(color({ transfer: 'bt709' }, pq, isoLayout()), 'colorTransfer'), 'mismatch');
  expectEq('color: none against none', verdict(color({}, {}, isoLayout()), 'colorPrimaries'), 'exact');
  const sps = isoLayout({ entry: entry({ config: { kind: 'avcC', profile: 66, constraints: 0xc0, bitDepth: 8, hasSps: true } }) });
  expectEq('color: none against an SPS value is a mismatch', verdict(color({}, pq, sps), 'colorPrimaries'), 'mismatch');
  const av1 = isoLayout({ entry: entry({ type: 'av01', config: { kind: 'av1C', profile: 0, constraints: null, bitDepth: 10, hasSps: null } }) });
  const silent = find(color({}, { colorRange: 'tv' }, av1, 'av1'), 'colorRange');
  expectEq('color: none against an AV1 bitstream value is a built-in deviation', `${silent?.verdict} ${silent?.deviation}`, `known-deviation ${BITSTREAM_COLOR}`);
  const colr = isoLayout({ entry: entry({ type: 'av01', colr: { kind: 'nclx', primaries: 9, transfer: 16, matrix: 9, fullRange: false } }) });
  expectEq('color: none against a colr value is a mismatch', verdict(color({}, pq, colr, 'av1'), 'colorTransfer'), 'mismatch');
  const nclc = isoLayout({ entry: entry({ type: 'av01', colr: { kind: 'nclc', primaries: 1, transfer: 1, matrix: 1, fullRange: null } }) });
  expectEq('color: nclc declares no range', verdict(color({}, { colorRange: 'tv' }, nclc, 'av1'), 'colorRange'), 'known-deviation');
  expectEq('color: no checks when color is not provided', verdict(mp4({}, pq), 'colorRange'), 'missing');

  const hvcc = isoLayout({ entry: entry({ type: 'hvc1', config: { kind: 'hvcC', profile: 2, constraints: 0x20000000, bitDepth: 10, hasSps: true } }) });
  expectEq('bitDepth: equal to pix_fmt', verdict(color({ bitDepth: 10 }, { bitDepth: 10, pixFmt: 'yuv420p10le' }, hvcc, 'hevc'), 'bitDepth'), 'exact');
  expectEq('bitDepth: none although hvcC carries one', verdict(color({}, { bitDepth: 10 }, hvcc, 'hevc'), 'bitDepth'), 'mismatch');
  expectEq('bitDepth: none without a configuration', verdict(color({}, { bitDepth: 8 }, isoLayout(), 'mjpeg'), 'bitDepth'), 'n/a');
  expectEq('profile: Constrained Baseline from the constraint flags', verdict(color({ profile: 66 }, {}, sps), 'profile'), 'exact');
  expectEq('profile: Main 10', verdict(color({ profile: 2 }, { profile: 'Main 10' }, hvcc, 'hevc'), 'profile'), 'exact');
  expectEq('profile: Baseline without the constraint flags', verdict(color({ profile: 66 }, {}, isoLayout()), 'profile'), 'mismatch');
  expectEq('profile: constraint flags from the codec string', verdict(color({ profile: 66, codecString: 'avc1.42C00B' }, {}, isoLayout()), 'profile'), 'exact');
  expectEq('profile: a pair missing from the table', verdict(color({ profile: 99 }, {}, sps), 'profile'), 'mismatch');
  expectEq('profile: none although avcC carries one', verdict(color({}, {}, sps), 'profile'), 'mismatch');
  expectEq('table: Constrained Baseline', ffmpegProfileName('h264', 66, 0xc0), 'Constrained Baseline');
  expectEq('table: Baseline', ffmpegProfileName('h264', 66, 0x80), 'Baseline');
  expectEq('table: High 10 Intra', ffmpegProfileName('h264', 110, 0x10), 'High 10 Intra');
  expectEq('table: VP9 Profile 2', ffmpegProfileName('vp9', 2, null), 'Profile 2');
  expectEq('table: AV1 Main', ffmpegProfileName('av1', 0, null), 'Main');

  const strings = new Map([[1, 'avc1.42C00B']]);
  const cs = (codecString: string | null, map: ReadonlyMap<number, string> | null) => run({ info: MP4_INFO, ref: refFile([refStream()]), result: appResult([track({ color: { ...NO_COLOR, codecString } })]), codecStrings: map });
  expectEq('codecString: equal to mp4box.js', verdict(cs('avc1.42C00B', strings), 'codecString'), 'exact');
  expectEq('codecString: different', verdict(cs('avc1.42C01E', strings), 'codecString'), 'mismatch');
  expectEq('codecString: no oracle is n/a', verdict(cs('avc1.42C00B', null), 'codecString'), 'n/a');
  expectEq('codecString: none for a codec without a rule', verdict(cs(null, new Map([[1, 'mp4v.20.9']])), 'codecString'), 'n/a');
  expectEq('codecString: none for H.264', verdict(cs(null, strings), 'codecString'), 'mismatch');
  const mkvCs = run({ info: MKV_INFO, ref: refFile([refStream()], { formatName: 'matroska,webm' }), result: appResult([track({ color: { ...NO_COLOR, codecString: 'vp09.00.10.08' } })], { container: 'webm', scan: 'exact' }) });
  expectEq('codecString: n/a on Matroska', verdict(mkvCs, 'codecString'), 'n/a');

  const record = { versionMajor: 1, versionMinor: 0, profile: 8, level: 1, rpu: true, el: false, bl: true, compatibilityId: 1, mdCompression: 1 };
  expectEq('dolbyVision: equal', verdict(color({ dolbyVision: record }, { dolbyVision: record }, isoLayout()), 'dolbyVision'), 'exact');
  expectEq('dolbyVision: another metadata compression', verdict(color({ dolbyVision: { ...record, mdCompression: 0 } }, { dolbyVision: record }, isoLayout()), 'dolbyVision'), 'mismatch');
  expectEq('dolbyVision: none against a record', verdict(color({}, { dolbyVision: record }, isoLayout()), 'dolbyVision'), 'mismatch');
  expectEq('dolbyVision: none on both sides', verdict(color({}, {}, isoLayout()), 'dolbyVision'), 'exact');

  const lay = isoLayout();
  const withLayout = (fields: FileFields040, layout: FileLayout | null, info = MP4_INFO, over: Partial<FileResult> = {}) => run({ info, ref: refFile([refStream()]), result: { ...appResult([appTrack()], over), ...fields }, layout });
  expectEq('layout: equal to the scan', verdict(withLayout({ layout: expectedLayout(lay) }, lay), 'layout'), 'exact');
  expectEq('layout: moov at the end', expectedLayout(lay)?.kind, 'moov-at-end');
  expectEq('layout: another kind', verdict(withLayout({ layout: { ...expectedLayout(lay)!, kind: 'faststart' } }, lay), 'layout'), 'mismatch');
  expectEq('layout: fragmented from mvex', expectedLayout(isoLayout({ samples: 0 }, { hasMvex: true, sidxBeforeFirstMoof: true }))?.emptyMoov, true);
  expectEq('layout: null for Matroska', verdict(withLayout({ layout: null }, mkvLayout(), MKV_INFO, { container: 'webm' }), 'layout'), 'exact');
  expectEq('errorCode: null with no error', verdict(withLayout({ errorCode: null }, null), 'errorCode'), 'exact');
  expectEq('errorCode: null with an error', verdict(withLayout({ errorCode: null }, null, { ...MP4_INFO, expect: 'error' }, { error: 'corrupt file: x', videoTracks: [], primaryTrackId: null }), 'errorCode'), 'mismatch');
  expectEq('errorCode: the manifest code', verdict(withLayout({ errorCode: 'corrupt' }, null, { ...MP4_INFO, expect: 'error', code: 'corrupt' }, { error: 'corrupt file: x', videoTracks: [], primaryTrackId: null }), 'errorCode'), 'exact');
  expectEq('errorCode: another code than the manifest', verdict(withLayout({ errorCode: 'truncated' }, null, { ...MP4_INFO, expect: 'error', code: 'corrupt' }, { error: 'corrupt file: x', videoTracks: [], primaryTrackId: null }), 'errorCode'), 'mismatch');

  let unmapped = 0;
  for (const m of loadManifest()) {
    const raw = loadRef(m.name);
    if (!raw) continue;
    for (const st of parseRef(m.name, raw).videoStreams) unmapped += st.unmappedSideData.length;
  }
  expectEq('every side data key the corpus prints is mapped', unmapped, 0);
}

export async function profileCoverage(expectEq: ExpectEq, pathOf: (name: string) => string | null): Promise<number> {
  let checked = 0;
  const printed = new Set<string>();
  for (const m of loadManifest()) {
    const raw = loadRef(m.name);
    const path = pathOf(m.name);
    if (!raw || !path) continue;
    const ref = parseRef(m.name, raw);
    if (!ref.ok || ref.videoStreams.length === 0) continue;
    const size = statSync(path).size;
    const iso = m.container === 'mp4' || m.container === 'mov';
    const layout = iso ? await scanIsoBmffLayout(path, size) : m.container === 'webm' || m.container === 'matroska' ? await scanMatroskaLayout(path, size) : null;
    const isoVideo = (layout?.tracks ?? []).filter((t) => t.handler === 'vide');
    ref.videoStreams.forEach((s, i) => {
      if (s.profile === null) return;
      printed.add(`${s.codecName}\t${s.profile}`);
      if (PROFILE_NOT_READ[s.codecName]) return;
      const config = iso ? (isoVideo.length === ref.videoStreams.length ? isoVideo[i]?.entry?.config : null) : matroskaTrackOf(layout, ref.videoStreams, s)?.config;
      if (config?.profile == null) return;
      expectEq(`profile table: ${m.name} stream ${s.index} (${s.codecName} ${config.profile}, constraints ${config.constraints ?? 'none'})`, ffmpegProfileName(s.codecName, config.profile, config.constraints), s.profile);
      checked++;
    });
  }
  for (const pair of printed) {
    const [codec, name] = pair.split('\t');
    if (PROFILE_NOT_READ[codec]) continue;
    expectEq(`profile table covers ${codec} "${name}"`, profileNamesOf(codec).includes(name), true);
  }
  expectEq('profile table: every codec of the table has a name', PROFILE_TABLE.every((e) => e.name.length > 0), true);
  return checked;
}
