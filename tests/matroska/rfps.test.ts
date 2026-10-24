import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/core/analyze.ts';
import { av1TimingInfo, h264Unsupported } from '../../src/core/rfps.ts';
import type { FileResult, MatroskaMode } from '../../src/core/types.ts';
import { fixturePath, loadRef } from '../helpers/fixtures.ts';
import { withFixture } from '../helpers/open-blob.ts';
import { cluster, concat, ebmlHeader, el, file, ID, info, segment, simpleBlock, str, trackEntry, uint, type TrackSpec } from './ebml-builder.ts';

const VERIFIED: ReadonlyArray<readonly [name: string, r: string, avg: string, packets: number]> = [
  ['rec_chromium_vp8.webm', '60000/1001', '60000/1001', 41],
  ['rec_chromium_vp8_sliced.webm', '60/1', '60/1', 41],
  ['rec_chromium_vp9.webm', '60/1', '60/1', 41],
  ['rec_chromium_vp9_sliced.webm', '60/1', '60/1', 41],
  ['rec_chromium_av1.webm', '60/1', '60/1', 41],
  ['rec_chromium_av1_sliced.webm', '60/1', '60/1', 41],
  ['rec_chromium_h264.mkv', '60/1', '60/1', 48],
  ['rec_chromium_h264_sliced.mkv', '60000/1001', '60000/1001', 48],
  ['vfr_concat_10_30_60.webm', '30/1', '0/0', 41],
  ['vfr_two_phase_5_200.webm', '200/1', '0/0', 41],
  ['late_25_to_12.5.webm', '25/1', '25/1', 41],
  ['vp9_no_defaultduration.webm', '30000/1001', '30000/1001', 41],
];

const estimated = (packets: number): string => `no DefaultDuration: avg_frame_rate and r_frame_rate estimated like ffprobe from ${packets} video packets`;
const HEADER_ONLY = 'no DefaultDuration: avg_frame_rate and r_frame_rate come from the first packets, which header mode does not read';

async function run(name: string, mode: MatroskaMode): Promise<FileResult> {
  const path = fixturePath(name);
  if (!path) throw new Error(`fixture ${name} is missing`);
  return withFixture(path, (blob) => analyze(blob, name, { matroskaMode: mode }));
}

const hex = (s: string): Uint8Array => Uint8Array.from(s.split(' ').map((x) => parseInt(x, 16)));
const OPUS_HEAD = concat([...'OpusHead'].map((c) => c.charCodeAt(0)), [1, 2, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0]);
const opusTrack = (number: number, codecPrivate = OPUS_HEAD): Uint8Array =>
  el(ID.TrackEntry, concat(uint(ID.TrackNumber, number), uint(ID.TrackUID, number), uint(ID.TrackType, 2), str(ID.CodecID, 'A_OPUS'), el(0x63a2, codecPrivate)));
const opusBlock = (rel: number): Uint8Array => el(ID.SimpleBlock, concat([0x82, (rel >> 8) & 0xff, rel & 0xff, 0x80, 0x78], new Uint8Array(20)));

function mkv(entries: Uint8Array[], clusters: Uint8Array[]): Blob {
  return file(ebmlHeader(), segment([info(), el(ID.Tracks, concat(...entries)), ...clusters]));
}

function videoClusters(frames: number, periodMs: number, extra: (ms: number) => Uint8Array[] = () => []): Uint8Array[] {
  const blocks: Uint8Array[] = [];
  for (let i = 0; i < frames; i++) blocks.push(...extra(i * periodMs), simpleBlock({ track: 1, rel: i * periodMs, payload: 32 }));
  return [cluster(0, blocks)];
}

const VP9: TrackSpec = { number: 1, codecId: 'V_VP9' };

async function rates(blob: Blob, mode: MatroskaMode = 'exact') {
  const r = await analyze(blob, 'x.webm', { matroskaMode: mode });
  expect(r.error).toBeNull();
  const t = r.videoTracks[0];
  return { r: t.rFpsFfprobe, avg: t.avgFpsFfprobe, note: t.warnings.find((w) => w.startsWith('no DefaultDuration')) ?? null };
}

function sps(vui: ((u: (n: number, v: number) => void, ue: (v: number) => void) => void) | null, profile = 66): Uint8Array {
  const bits: number[] = [];
  const u = (n: number, v: number): void => {
    for (let i = n - 1; i >= 0; i--) bits.push(Math.floor(v / 2 ** i) % 2);
  };
  const ue = (v: number): void => {
    const len = Math.floor(Math.log2(v + 1)) + 1;
    u(len - 1, 0);
    u(len, v + 1);
  };
  u(8, profile);
  u(8, 0xc0);
  u(8, 30);
  [0, 0, 2, 1].forEach(ue);
  u(1, 0);
  ue(19);
  ue(14);
  u(3, 0b110);
  if (vui) vui(u, ue);
  else u(1, 0);
  u(1, 1);
  while (bits.length % 8) bits.push(0);
  const out = [0x67];
  for (let i = 0; i < bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  return Uint8Array.from(out);
}

describe('ffprobe frame rates of Matroska without DefaultDuration', () => {
  describe.each(['probe', 'exact', 'auto'] as const)('matroskaMode %s', (mode) => {
    it.each(VERIFIED)('%s: r_frame_rate %s and avg_frame_rate %s, as ffprobe 8.1.1', async (name, r, avg, packets) => {
      const result = await run(name, mode);
      const t = result.videoTracks[0];
      const ref = loadRef(name)!.videos![0];
      expect([ref.r_frame_rate, ref.avg_frame_rate]).toEqual([r, avg]);
      expect([t.rFpsFfprobe, t.avgFpsFfprobe]).toEqual([r, avg]);
      expect(t.warnings).toContain(estimated(packets));
    });
  });

  it.each(VERIFIED)('%s: header mode reads no block and estimates nothing', async (name) => {
    const t = (await run(name, 'header')).videoTracks[0];
    expect([t.rFpsFfprobe, t.avgFpsFfprobe]).toEqual([null, null]);
    expect(t.warnings).toContain(HEADER_ONLY);
  });

  it('takes r_frame_rate from the timestamp gcd and avg_frame_rate from it when the mean interval agrees', async () => {
    expect(await rates(mkv([trackEntry(VP9)], videoClusters(60, 40)))).toEqual({ r: '25/1', avg: '25/1', note: estimated(41) });
  });

  it('keeps reading until every Opus track has a block, then stops', async () => {
    const late = (ms: number): Uint8Array[] => (ms === 2000 ? [opusBlock(ms)] : []);
    expect(await rates(mkv([trackEntry(VP9), opusTrack(2)], videoClusters(80, 40, late)))).toEqual({ r: '25/1', avg: '25/1', note: estimated(50) });
    const early = (ms: number): Uint8Array[] => (ms % 20 === 0 ? [opusBlock(ms)] : []);
    expect(await rates(mkv([trackEntry(VP9), opusTrack(2)], videoClusters(80, 40, early)))).toEqual({ r: '25/1', avg: '25/1', note: estimated(41) });
  });

  it.each([
    ['a second video track', [trackEntry(VP9), trackEntry({ number: 2, codecId: 'V_VP9' })], videoClusters(60, 40), '2 video tracks'],
    ['a Vorbis track', [trackEntry(VP9), el(ID.TrackEntry, concat(uint(ID.TrackNumber, 2), uint(ID.TrackUID, 2), uint(ID.TrackType, 2), str(ID.CodecID, 'A_VORBIS')))], videoClusters(60, 40), 'track 2 (A_VORBIS)'],
    ['an Opus track with channel mapping family 1', [trackEntry(VP9), opusTrack(2, concat(OPUS_HEAD.subarray(0, 18), [1]))], videoClusters(60, 40), 'track 2 (A_OPUS)'],
    ['duplicate track numbers', [trackEntry(VP9), opusTrack(1)], videoClusters(60, 40), 'duplicate track numbers'],
    ['a TrackTimestampScale', [trackEntry({ ...VP9, trackTimestampScale: 2 })], videoClusters(60, 40), 'track 1 scale or encoding'],
    ['an unsupported codec', [trackEntry({ number: 1, codecId: 'V_MPEGH/ISO/HEVC' })], videoClusters(60, 40), 'codec V_MPEGH/ISO/HEVC'],
    ['a laced block', [trackEntry(VP9)], [cluster(0, [simpleBlock({ track: 1, rel: 0 }), simpleBlock({ track: 1, rel: 40, laces: 3, payload: 30 })])], 'laced or untimed blocks'],
    ['a first block that is not a keyframe', [trackEntry(VP9)], [cluster(0, [simpleBlock({ track: 1, rel: 0, flags: 0 }), simpleBlock({ track: 1, rel: 40 })])], 'no keyframe first'],
    ['H.264 without an SPS', [trackEntry({ number: 1, codecId: 'V_MPEG4/ISO/AVC' })], videoClusters(60, 40), 'no H.264 SPS'],
  ] as const)('reports no estimate for %s, with the reason', async (_label, entries, clusters, reason) => {
    expect(await rates(mkv([...entries], [...clusters]))).toEqual({ r: null, avg: null, note: `no DefaultDuration: avg_frame_rate and r_frame_rate not reproduced (${reason})` });
  });

  it('accepts a Baseline H.264 SPS without timing info, as Chrome writes it', () => {
    expect(h264Unsupported(hex('67 42 c0 15 8c 68 14 19 79 e6 e0 21 a0 20 f0 88 46 a0'))).toBeNull();
    expect(h264Unsupported(sps(null))).toBeNull();
  });

  it('rejects H.264 that sets a codec frame rate, reorders frames or is not Baseline', () => {
    const vui = (timing: number, reorder: number) => (u: (n: number, v: number) => void, ue: (v: number) => void) => {
      u(5, 0b10000);
      u(1, timing);
      if (timing) u(32 + 32 + 1, 0);
      u(3, 0);
      u(2, 0b11);
      for (let i = 0; i < 4; i++) ue(0);
      ue(reorder);
      ue(reorder);
    };
    expect(h264Unsupported(sps(vui(0, 0)))).toBeNull();
    expect(h264Unsupported(sps(vui(1, 0)))).toBe('H.264 timing info');
    expect(h264Unsupported(sps(vui(0, 2)))).toBe('H.264 reordering');
    expect(h264Unsupported(sps(null, 100))).toBe('H.264 profile 100');
    expect(h264Unsupported(hex('67 42'))).toBe('bad H.264 SPS');
  });

  it('reads the AV1 timing info flag of the sequence header', () => {
    const chrome = '12 00 0a 0d 00 00 00 04 3c fe cc 01 a2 02 1a 03 08';
    expect(av1TimingInfo(hex(chrome))).toBe(false);
    expect(av1TimingInfo(hex(chrome.replace('0a 0d 00', '0a 0d 04')))).toBe(true);
    expect(av1TimingInfo(hex(chrome.replace('0a 0d 00', '0a 0d 0c')))).toBe(false);
    expect(av1TimingInfo(hex('12 00'))).toBeNull();
  });
});
