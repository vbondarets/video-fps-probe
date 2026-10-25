import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/core/analyze.ts';
import { av1TimingInfo, h264Sps } from '../../src/core/rfps.ts';
import type { FileResult, MatroskaMode } from '../../src/core/types.ts';
import { fixturePath, loadRef } from '../helpers/fixtures.ts';
import { withFixture } from '../helpers/open-blob.ts';
import { blockGroup, cfrClusters, cluster, concat, ebmlHeader, el, file, ID, info, segment, simpleBlock, str, trackEntry, uint, type TrackSpec } from './ebml-builder.ts';

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

type BitWriter = (u: (n: number, v: number) => void, ue: (v: number) => void) => void;

function nal(header: number, write: BitWriter): Uint8Array {
  const bits: number[] = [];
  const u = (n: number, v: number): void => {
    for (let i = n - 1; i >= 0; i--) bits.push(Math.floor(v / 2 ** i) % 2);
  };
  const ue = (v: number): void => {
    const len = Math.floor(Math.log2(v + 1)) + 1;
    u(len - 1, 0);
    u(len, v + 1);
  };
  write(u, ue);
  u(1, 1);
  while (bits.length % 8) bits.push(0);
  const out = [header];
  for (let i = 0, zeros = 0; i < bits.length; i += 8) {
    const byte = parseInt(bits.slice(i, i + 8).join(''), 2);
    if (zeros >= 2 && byte <= 3) {
      out.push(3);
      zeros = 0;
    }
    out.push(byte);
    zeros = byte ? 0 : zeros + 1;
  }
  return Uint8Array.from(out);
}

const POC2: BitWriter = (_u, ue) => ue(2);
const POC1: BitWriter = (u, ue) => {
  ue(1);
  u(1, 0);
  ue(0);
  ue(0);
  ue(1);
  ue(1);
};
const poc0 =
  (lsbBits: number): BitWriter =>
  (_u, ue) => {
    ue(0);
    ue(lsbBits - 4);
  };

function sps(vui: BitWriter | null, profile = 66, poc: BitWriter = POC2, fields = false): Uint8Array {
  return nal(0x67, (u, ue) => {
    u(8, profile);
    u(8, 0xc0);
    u(8, 30);
    ue(0);
    ue(0);
    poc(u, ue);
    ue(1);
    u(1, 0);
    ue(19);
    ue(14);
    u(1, fields ? 0 : 1);
    if (fields) u(1, 0);
    u(2, 0b10);
    u(1, vui ? 1 : 0);
    vui?.(u, ue);
  });
}

const vui =
  (timing: number, reorder: number): BitWriter =>
  (u, ue) => {
    u(4, 0);
    u(1, timing);
    if (timing) u(32 + 32 + 1, 0);
    u(3, 0);
    u(2, 0b11);
    for (let i = 0; i < 4; i++) ue(0);
    ue(reorder);
    ue(reorder);
  };

const pps = (bottom = 0): Uint8Array =>
  nal(0x68, (u, ue) => {
    ue(0);
    ue(0);
    u(1, 0);
    u(1, bottom);
    ue(0);
  });

interface SliceSpec {
  idr?: boolean;
  ref?: boolean;
  frameNum: number;
  lsb?: number;
  lsbBits?: number;
}

const slice = (x: SliceSpec): Uint8Array =>
  nal((x.ref === false ? 0 : 0x60) | (x.idr ? 5 : 1), (u, ue) => {
    ue(0);
    ue(x.idr ? 7 : 5);
    ue(0);
    u(4, x.frameNum % 16);
    if (x.idr) ue(0);
    if (x.lsb !== undefined) u(x.lsbBits ?? 8, x.lsb % 2 ** (x.lsbBits ?? 8));
  });

const avcc = (spsNal: Uint8Array, ppsNal: Uint8Array): Uint8Array =>
  concat([1, spsNal[1], spsNal[2], spsNal[3], 0xff, 0xe1, spsNal.length >> 8, spsNal.length & 0xff], spsNal, [1, ppsNal.length >> 8, ppsNal.length & 0xff], ppsNal);

const lengthPrefixed = (...nals: Uint8Array[]): Uint8Array => concat(...nals.map((n) => concat([0, 0, 0, n.length], n)));
const annexB = (...nals: Uint8Array[]): Uint8Array => concat(...nals.map((n) => concat([0, 0, 0, 1], n)));

const avcTrack = (codecPrivate: Uint8Array | null): Uint8Array =>
  el(ID.TrackEntry, concat(uint(ID.TrackNumber, 1), uint(ID.TrackUID, 1), uint(ID.TrackType, 1), str(ID.CodecID, 'V_MPEG4/ISO/AVC'), codecPrivate ? el(0x63a2, codecPrivate) : []));

function avcFile(codecPrivate: Uint8Array | null, payloads: readonly Uint8Array[]): Blob {
  const blocks = payloads.map((p, i) => el(ID.SimpleBlock, concat([0x81, ((i * 40) >> 8) & 0xff, (i * 40) & 0xff, i === 0 ? 0x80 : 0], p)));
  return mkv([avcTrack(codecPrivate)], [cluster(0, blocks)]);
}

function avcSlices(n: number, lsbStep: number | null, skip: number | null = null): Uint8Array[] {
  return Array.from({ length: n }, (_, i) => {
    const k = skip !== null && i >= skip ? i + 1 : i;
    return slice({ idr: i === 0, frameNum: k, lsb: lsbStep === null ? undefined : k * lsbStep });
  });
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

  it('holds a track without durations against 5 s only from its 31st packet, and one with BlockDurations by their sum', async () => {
    const slow = (blocks: (i: number) => Uint8Array): Blob => mkv([trackEntry(VP9)], [cluster(0, Array.from({ length: 60 }, (_, i) => blocks(i)))]);
    expect(await rates(slow((i) => simpleBlock({ track: 1, rel: i * 500 })))).toEqual({ r: '2/1', avg: '2/1', note: estimated(31) });
    expect(await rates(mkv([trackEntry(VP9)], cfrClusters({ frames: 60, periodMs: 1000 })))).toEqual({ r: '1/1', avg: '1/1', note: estimated(31) });
    expect(await rates(slow((i) => blockGroup({ track: 1, rel: i * 500 }, 500)))).toEqual({ r: '2/1', avg: '2/1', note: estimated(12) });
  });

  it.each(['exact', 'auto'] as const)('rides the block walk of the %s scan instead of reading the first Clusters again', async (mode) => {
    const big = (t: TrackSpec): Blob => mkv([trackEntry(t)], cfrClusters({ frames: 150, periodMs: 40, payload: 20_000 }));
    const scan = (blob: Blob) => analyze(blob, 'x.webm', { matroskaMode: mode });
    const [estimatedRun, declared] = await Promise.all([scan(big(VP9)), scan(big({ ...VP9, defaultDuration: 40_000_000 }))]);
    expect([estimatedRun.scan, estimatedRun.videoTracks[0].avgFpsFfprobe]).toEqual(['exact', '25/1']);
    expect(estimatedRun.videoTracks[0].warnings).toContain(estimated(41));
    expect(estimatedRun.io).toMatchObject({ reads: declared.io.reads, bytesRead: declared.io.bytesRead });
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

  it('reads a Baseline H.264 SPS without timing info, as Chrome writes it, whose bitstream_restriction fixes the reorder delay at 0', () => {
    expect(h264Sps(hex('67 42 c0 15 8c 68 14 19 79 e6 e0 21 a0 20 f0 88 46 a0'))).toBeNull();
    expect(h264Sps(sps(vui(0, 0)))).toBeNull();
    expect(h264Sps(sps(null))).toEqual({ frameNumBits: 4, pocType: 2, pocLsbBits: 0 });
    expect(h264Sps(sps(null, 66, poc0(6)))).toEqual({ frameNumBits: 4, pocType: 0, pocLsbBits: 6 });
  });

  it('rejects H.264 that sets a codec frame rate, reorders frames or is not Baseline', () => {
    expect(h264Sps(sps(vui(1, 0)))).toBe('H.264 timing info');
    expect(h264Sps(sps(vui(0, 2)))).toBe('H.264 reordering');
    expect(h264Sps(sps(null, 100))).toBe('H.264 profile 100');
    expect(h264Sps(hex('67 42'))).toBe('bad H.264 SPS');
  });

  describe('H.264 without bitstream_restriction, whose decoder delay FFmpeg raises on a POC step above 2', () => {
    const POC0 = sps(null, 66, poc0(8));
    const POC0_SHORT = sps(null, 66, poc0(4));
    const OPEN = sps(null);
    const lengthed = (slices: readonly Uint8Array[]): Uint8Array[] => slices.map((s) => lengthPrefixed(s));
    const run = (spsNal: Uint8Array, slices: readonly Uint8Array[], ppsNal = pps()) => rates(avcFile(avcc(spsNal, ppsNal), lengthed(slices)));
    const notReproduced = (reason: string) => ({ r: null, avg: null, note: `no DefaultDuration: avg_frame_rate and r_frame_rate not reproduced (${reason})` });
    const ESTIMATED = { r: '25/1', avg: '25/1', note: estimated(48) };
    const decoded = (specs: readonly SliceSpec[], lsbBits = 8): Uint8Array[] => [
      ...specs.map((x) => slice({ lsbBits, ...x })),
      ...Array.from({ length: 60 - specs.length }, (_, i) => slice({ frameNum: specs.length + i })),
    ];

    it.each([
      ['POC type 0 in steps of 2', POC0, avcSlices(60, 2)],
      ['POC type 0 in steps of 4 with bitstream_restriction', sps(vui(0, 0), 66, poc0(8)), avcSlices(60, 4)],
      ['POC type 2 with consecutive frame_num', OPEN, avcSlices(60, null)],
      ['POC type 2 with a frame_num gap after the 7 decoded packets', OPEN, avcSlices(60, null, 7)],
      ['POC type 2 with a frame_num gap and bitstream_restriction', sps(vui(0, 0)), avcSlices(60, null, 2)],
    ] as const)('estimates %s', async (_label, spsNal, slices) => {
      expect(await run(spsNal, slices)).toEqual(ESTIMATED);
    });

    const fieldSlices = avcSlices(60, 2).map((_s, i) =>
      nal(i ? 0x61 : 0x65, (u, ue) => {
        ue(0);
        ue(i ? 5 : 7);
        ue(0);
        u(4, i);
        u(1, 1);
      }),
    );

    it.each([
      ['POC type 0 in steps of 4', POC0, avcSlices(60, 4), 'H.264 POC step 4'],
      ['POC type 0 that falls back', POC0, avcSlices(60, 2).map((s, i) => (i === 5 ? slice({ frameNum: 5, lsb: 2 }) : s)), 'H.264 POC step -6'],
      ['POC type 2 with a frame_num gap in the decoded packets', OPEN, avcSlices(60, null, 3), 'H.264 frame_num gap'],
      ['POC type 1', sps(null, 66, POC1), avcSlices(60, null), 'H.264 pic_order_cnt_type 1'],
      ['field coding', sps(null, 66, poc0(8), true), fieldSlices, 'H.264 field coding'],
      ['a bottom field POC offset', POC0, avcSlices(60, 2), 'H.264 bottom field POC', pps(1)],
      ['a first slice that is not an IDR', POC0, avcSlices(60, 2).map((s, i) => (i ? s : slice({ frameNum: 0, lsb: 0 }))), 'H.264 does not start with an IDR'],
      ['a first slice that is not an IDR, with bitstream_restriction', sps(vui(0, 0)), avcSlices(60, null).map((s, i) => (i ? s : slice({ frameNum: 0 }))), 'H.264 does not start with an IDR'],
      ['a packet without a slice', POC0, avcSlices(60, 2).map((s, i) => (i === 4 ? nal(0x06, (u) => u(8, 5)) : s)), 'no H.264 slice header'],
      ['a slice header cut short', POC0, avcSlices(60, 2).map((s, i) => (i === 2 ? s.subarray(0, 2) : s)), 'bad H.264 PPS or slice header'],
    ] as const)('reports no estimate for %s', async (_label, spsNal, slices, reason, ppsNal = pps()) => {
      expect(await run(spsNal, slices, ppsNal)).toEqual(notReproduced(reason));
    });

    it('follows pic_order_cnt_lsb across its wrap', async () => {
      const wrap = [10, 12, 14, 0, 2, 4, 6].map((lsb, frameNum) => ({ idr: frameNum === 0, frameNum, lsb }));
      expect(await run(POC0_SHORT, decoded(wrap, 4))).toEqual(ESTIMATED);
      const back = [0, 14, 0, 2, 4, 6, 8].map((lsb, frameNum) => ({ idr: frameNum === 0, frameNum, lsb }));
      expect(await run(POC0_SHORT, decoded(back, 4))).toEqual(notReproduced('H.264 POC step -2'));
    });

    it('restarts the POC at an IDR', async () => {
      const specs = [0, 2, 40, 42, 44, 46, 48].map((lsb, i) => ({ idr: i === 0 || i === 2, frameNum: i < 2 ? i : i - 2, lsb }));
      expect(await run(POC0, decoded(specs))).toEqual(ESTIMATED);
    });

    it('takes the msb of pic_order_cnt_lsb from reference pictures only, as the standard does', async () => {
      const specs = [0, 2, 4, 6, 8, 10, 12].map((lsb, i) => ({ idr: i === 0, ref: i === 0 || i === 6, frameNum: i ? 1 : 0, lsb }));
      expect(await run(POC0_SHORT, decoded(specs, 4))).toEqual(notReproduced('H.264 POC step -14'));
    });

    it('counts POC type 2 from frame_num, one below for a non-reference picture, across the frame_num wrap', async () => {
      const nonRef = [0, 1, 1, 2, 3, 4, 5].map((frameNum, i) => ({ idr: i === 0, ref: i !== 1, frameNum }));
      expect(await run(OPEN, decoded(nonRef))).toEqual(ESTIMATED);
      expect(await run(OPEN, decoded([14, 15, 0, 1, 2, 3, 4].map((frameNum, i) => ({ idr: i === 0, frameNum }))))).toEqual(ESTIMATED);
      const twoNonRef = [0, 1, 1, 1, 2, 3, 4].map((frameNum, i) => ({ idr: i === 0, ref: i !== 1 && i !== 2, frameNum }));
      expect(await run(OPEN, decoded(twoNonRef))).toEqual(notReproduced('H.264 POC step 0'));
    });

    it('reads the SPS, the PPS and the slices of Annex B packets without CodecPrivate', async () => {
      const inBand = (slices: readonly Uint8Array[]): Uint8Array[] => slices.map((s, i) => (i ? annexB(s) : annexB(POC0, pps(), s)));
      expect(await rates(avcFile(null, inBand(avcSlices(60, 2))))).toEqual(ESTIMATED);
      expect(await rates(avcFile(null, inBand(avcSlices(60, 4))))).toEqual(notReproduced('H.264 POC step 4'));
    });

    it('reads the SPS of CodecPrivate only up to its length', async () => {
      const cp = concat([1, 66, 0xc0, 30, 0xff, 0xe1, 0, 3], POC0.subarray(0, 3), [1, 0, 0]);
      expect(await rates(avcFile(cp, lengthed(avcSlices(60, 2))))).toEqual(notReproduced('bad H.264 SPS'));
    });
  });

  it('reads the AV1 timing info flag of the sequence header', () => {
    const chrome = '12 00 0a 0d 00 00 00 04 3c fe cc 01 a2 02 1a 03 08';
    expect(av1TimingInfo(hex(chrome))).toBe(false);
    expect(av1TimingInfo(hex(chrome.replace('0a 0d 00', '0a 0d 04')))).toBe(true);
    expect(av1TimingInfo(hex(chrome.replace('0a 0d 00', '0a 0d 0c')))).toBe(false);
    expect(av1TimingInfo(hex('12 00'))).toBeNull();
  });
});
