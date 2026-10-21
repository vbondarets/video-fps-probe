import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/core/analyze.ts';
import { readHeader, readId, readSize, UNKNOWN_SIZE, vintLength } from '../../src/core/matroska/ebml.ts';
import { parseDurationTag } from '../../src/core/matroska/header.ts';
import { codecNameOf, declaredRate, mergeRunStats, planExactScan } from '../../src/core/matroska/index.ts';
import { parseBlockHeader } from '../../src/core/matroska/scan.ts';
import { resolveOptions } from '../../src/core/options.ts';
import { analyzeTimeline } from '../../src/core/stats.ts';
import type { AnalyzeOptions, FileResult } from '../../src/core/types.ts';
import {
  blockBody,
  blockGroup,
  cfrClusters,
  cluster,
  concat,
  durationTag,
  ebmlHeader,
  el,
  file,
  ID,
  info,
  segment,
  seekHead,
  simpleBlock,
  str,
  tracks,
  uint,
} from './ebml-builder.ts';

const u8 = (...b: number[]): Uint8Array => new Uint8Array(b);

async function run(blob: Blob, opts: AnalyzeOptions = {}): Promise<FileResult> {
  return analyze(blob, 'synthetic.webm', { matroskaMode: 'exact', ...opts });
}

function simpleFile(opts: { frames?: number; periodMs?: number; dd?: number; duration?: number; docType?: string } = {}): Blob {
  const frames = opts.frames ?? 90;
  const period = opts.periodMs ?? 1000 / 30;
  return file(
    ebmlHeader(opts.docType ?? 'webm'),
    segment([
      info({ duration: opts.duration }),
      tracks({ number: 1, defaultDuration: opts.dd ?? 33333333 }),
      ...cfrClusters({ frames, periodMs: period }),
    ]),
  );
}

describe('EBML VINT', () => {
  it('derives the length from the leading zero bits and rejects 0x00', () => {
    expect(vintLength(0x80)).toBe(1);
    expect(vintLength(0x40)).toBe(2);
    expect(vintLength(0x1a)).toBe(4);
    expect(vintLength(0x01)).toBe(8);
    expect(vintLength(0x00)).toBe(0);
    expect(readSize(u8(0x00, 0x81), 0)).toBeNull();
    expect(readId(u8(0x00, 0x81), 0)).toBeNull();
  });

  it('keeps the marker bit in IDs and limits them to 4 bytes', () => {
    expect(readId(u8(0x1a, 0x45, 0xdf, 0xa3), 0)).toEqual({ id: 0x1a45dfa3, length: 4 });
    expect(readId(u8(0xa3), 0)).toEqual({ id: 0xa3, length: 1 });
    expect(readId(u8(0x42, 0x82), 0)).toEqual({ id: 0x4282, length: 2 });
    expect(readId(u8(0x08, 1, 2, 3, 4), 0)).toBeNull();
    expect(readId(u8(0x1a, 0x45), 0)).toBeNull();
  });

  it('strips the marker bit from sizes', () => {
    expect(readSize(u8(0x81), 0)).toEqual({ size: 1, length: 1 });
    expect(readSize(u8(0x80), 0)).toEqual({ size: 0, length: 1 });
    expect(readSize(u8(0x40, 0x02), 0)).toEqual({ size: 2, length: 2 });
    expect(readSize(u8(0x10, 0x00, 0x00, 0x05), 0)).toEqual({ size: 5, length: 4 });
    expect(readSize(u8(0x41, 0xff), 0)).toEqual({ size: 0x1ff, length: 2 });
    expect(readSize(u8(0x7f, 0xfe), 0)).toEqual({ size: 0x3ffe, length: 2 });
    expect(readSize(u8(0x40), 0)).toBeNull();
  });

  it('detects unknown sizes from the raw bits at every length', () => {
    expect(readSize(u8(0xff), 0)?.size).toBe(UNKNOWN_SIZE);
    expect(readSize(u8(0x7f, 0xff), 0)?.size).toBe(UNKNOWN_SIZE);
    expect(readSize(u8(0x3f, 0xff, 0xff), 0)?.size).toBe(UNKNOWN_SIZE);
    expect(readSize(u8(0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff), 0)).toEqual({ size: UNKNOWN_SIZE, length: 8 });
    expect(readSize(u8(0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe), 0)).toBeNull();
    expect(readSize(u8(0x01, 0x1f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff), 0)).toEqual({ size: Number.MAX_SAFE_INTEGER, length: 8 });
    expect(readSize(u8(0x01, 0x20, 0, 0, 0, 0, 0, 0), 0)).toBeNull();
  });

  it('reads element headers with absolute offsets', () => {
    expect(readHeader(u8(0, 0, 0x1f, 0x43, 0xb6, 0x75, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff), 2, 100)).toEqual({
      id: 0x1f43b675,
      pos: 102,
      size: UNKNOWN_SIZE,
      dataStart: 114,
    });
  });
});

describe('block header', () => {
  it('reads track number, signed relative timestamp, flags and lace count', () => {
    expect(parseBlockHeader(blockBody({ track: 1, rel: -5, flags: 0x80 }), 0, 20)).toEqual({ track: 1, rel: -5, flags: 0x80, laces: 1 });
    expect(parseBlockHeader(blockBody({ track: 129, rel: 32767 }), 0, 20)).toEqual({ track: 129, rel: 32767, flags: 0x80, laces: 1 });
    expect(parseBlockHeader(blockBody({ track: 2, rel: 40, flags: 0x08, laces: 4 }), 0, 20)).toEqual({ track: 2, rel: 40, flags: 0x0e, laces: 4 });
    expect(parseBlockHeader(u8(0x81, 0x00), 0, 2)).toBeNull();
    expect(parseBlockHeader(u8(0x81, 0x00, 0x00, 0x06), 0, 4)).toBeNull();
  });

  it('counts laces as frames and spreads their timestamps over the block duration', async () => {
    const blob = file(
      ebmlHeader(),
      segment([
        info(),
        tracks({ number: 1, defaultDuration: 40_000_000 }),
        cluster(0, [simpleBlock({ track: 1, rel: 0, laces: 3 }), simpleBlock({ track: 1, rel: 120, laces: 3 })]),
      ]),
    );
    const r = await run(blob);
    const t = r.videoTracks[0];
    expect(t.frames).toBe(6);
    expect(t.minFps).toMatchObject({ num: 25, den: 1 });
    expect(t.maxFps).toMatchObject({ num: 25, den: 1 });
    expect(t.avgFps).toMatchObject({ num: 25, den: 1 });
    expect(t.durationSec).toBeCloseTo(0.24, 12);
  });

  it('keeps the frame count but drops timestamps of laces without any duration', async () => {
    const blob = file(ebmlHeader(), segment([info(), tracks({ number: 1 }), cluster(0, [simpleBlock({ track: 1, rel: 0, laces: 2 }), simpleBlock({ track: 1, rel: 40 })])]));
    const t = (await run(blob)).videoTracks[0];
    expect(t.frames).toBe(3);
    expect(t.warnings.join(' ')).toMatch(/1 laced frame/);
  });
});

describe('BlockGroup and BlockDuration', () => {
  it('uses BlockDuration for the last frame and counts every group', async () => {
    const groups = [blockGroup({ track: 1, rel: 0 }, 100), blockGroup({ track: 1, rel: 100 }, 17, uint(ID.ReferenceBlock, 1)), blockGroup({ track: 1, rel: 117 }, 50)];
    const blob = file(ebmlHeader('matroska'), segment([info(), tracks({ number: 1, codecId: 'V_MPEG4/ISO/AVC', defaultDuration: 23076923 }), el(ID.Cluster, concat(uint(ID.Timestamp, 0), ...groups))]));
    const r = await run(blob);
    const t = r.videoTracks[0];
    expect(r.container).toBe('matroska');
    expect(t.codecName).toBe('h264');
    expect(t.frames).toBe(3);
    expect(t.avgFps).toMatchObject({ num: 3000, den: 167 });
    expect(t.avgFpsFfprobe).toBe('130/3');
    expect(t.minFps).toMatchObject({ num: 10, den: 1 });
    expect(t.isVfr).toBe(true);
  });

  it('falls back to DefaultDuration x laces / TimestampScale with integer division', async () => {
    const blob = file(ebmlHeader(), segment([info(), tracks({ number: 1, defaultDuration: 33366666 }), ...cfrClusters({ frames: 3, periodMs: 1000 / 29.97 })]));
    const t = (await run(blob)).videoTracks[0];
    expect(t.durationSec).toBeCloseTo((66 + 33) / 1000, 12);
    expect(t.avgFps).toMatchObject({ num: 1000, den: 33 });
  });
});

describe('Info and Tracks', () => {
  it('reads Duration as a float of 0, 4 or 8 bytes, 0 meaning absent', async () => {
    for (const [len, value, expected] of [
      [8, 3003, 3.003],
      [4, 3003, 3.003],
      [8, 0, null],
      [0, 0, null],
    ] as const) {
      const blob = file(ebmlHeader(), segment([el(ID.Info, concat(uint(ID.TimestampScale, 1_000_000), el(ID.Duration, len === 0 ? [] : floatBytes(value, len)))), tracks({ number: 1, defaultDuration: 33366666 }), ...cfrClusters({ frames: 3, periodMs: 33.3667 })]));
      const r = await run(blob, { matroskaMode: 'header' });
      expect(r.formatDurationSec).toBe(expected);
    }
  });

  it('scales Duration by TimestampScale and truncates to microseconds like ffprobe', async () => {
    const blob = file(ebmlHeader(), segment([info({ timestampScale: 100_000, duration: 30030.5 }), tracks({ number: 1, defaultDuration: 33366666 }), cluster(0, [simpleBlock({ track: 1, rel: 0 })])]));
    const r = await run(blob, { matroskaMode: 'header' });
    expect(r.formatDurationSec).toBe(3.00305);
    expect(r.videoTracks[0].timescale).toBe(10000);
  });

  it('derives the declared rate from DefaultDuration with the ffprobe r rule', () => {
    expect(declaredRate(33366666)).toEqual({ avg: '30000/1001', r: '30000/1001' });
    expect(declaredRate(41708333)).toEqual({ avg: '24000/1001', r: '24000/1001' });
    expect(declaredRate(16683333)).toEqual({ avg: '19001/317', r: '19001/317' });
    expect(declaredRate(500_000_000)).toEqual({ avg: '2/1', r: null });
    expect(declaredRate(200_000_000)).toEqual({ avg: '5/1', r: null });
    expect(declaredRate(1_000_000)).toEqual({ avg: '1000/1', r: null });
    expect(declaredRate(0)).toBeNull();
  });

  it('uses the reclaimed Video FrameRate when DefaultDuration is missing (truncated to ns)', async () => {
    const blob = file(ebmlHeader(), segment([info(), tracks({ number: 1, frameRate: 59.94 }), ...cfrClusters({ frames: 3, periodMs: 16.68 })]));
    const r = await run(blob, { matroskaMode: 'header' });
    expect(r.videoTracks[0].avgFpsFfprobe).toBe(declaredRate(Math.trunc(1e9 / Math.fround(59.94)))?.avg);
    expect(r.videoTracks[0].nominalFps?.kind).toBe('declared');
  });

  it('maps CodecIDs by prefix like ffmpeg', () => {
    expect(codecNameOf('V_MPEG4/ISO/AVC')).toBe('h264');
    expect(codecNameOf('V_MPEGH/ISO/HEVC')).toBe('hevc');
    expect(codecNameOf('V_VP9')).toBe('vp9');
    expect(codecNameOf('V_AV1')).toBe('av1');
    expect(codecNameOf('V_MPEG4/ISO/ASP')).toBe('mpeg4');
    expect(codecNameOf('V_MS/VFW/FOURCC')).toBe('');
  });

  it('picks the first TrackType 1 as primary regardless of FlagDefault and counts audio', async () => {
    const blob = file(
      ebmlHeader('matroska'),
      segment([
        info(),
        tracks(
          { number: 1, type: 2, codecId: 'A_OPUS' },
          { number: 2, flagDefault: 0, defaultDuration: 40_000_000, width: 320, height: 180 },
          { number: 3, flagDefault: 1, defaultDuration: 33333333 },
        ),
        cluster(0, [simpleBlock({ track: 1, rel: 0 }), simpleBlock({ track: 2, rel: 0 }), simpleBlock({ track: 3, rel: 0 }), simpleBlock({ track: 2, rel: 40 }), simpleBlock({ track: 3, rel: 33 })]),
      ]),
    );
    const r = await run(blob);
    expect(r.primaryTrackId).toBe(2);
    expect(r.audioTrackCount).toBe(1);
    expect(r.videoTracks.map((t) => [t.trackId, t.frames, t.width])).toEqual([
      [2, 2, 320],
      [3, 2, 160],
    ]);
  });

  it('reports audio-only files without a video track and without an error', async () => {
    const blob = file(ebmlHeader(), segment([info({ duration: 1000 }), tracks({ number: 1, type: 2, codecId: 'A_OPUS' }), cluster(0, [simpleBlock({ track: 1, rel: 0 })])]));
    const r = await run(blob);
    expect(r.error).toBeNull();
    expect(r.videoTracks).toEqual([]);
    expect(r.primaryTrackId).toBeNull();
    expect(r.warnings).toContain('no video track');
  });

  it('applies TrackTimestampScale like ffmpeg 8.1.1 (time base 1/500, Cluster time divided by the scale)', async () => {
    const blob = file(
      ebmlHeader('matroska'),
      segment([
        info({ duration: 400 }),
        tracks({ number: 1, defaultDuration: 40_000_000, trackTimestampScale: 2 }),
        cluster(0, [0, 20, 40, 60, 80].map((rel) => simpleBlock({ track: 1, rel }))),
        cluster(201, [0, 20, 40].map((rel) => simpleBlock({ track: 1, rel }))),
      ]),
    );
    const t = (await run(blob)).videoTracks[0];
    expect(t.timescale).toBe(500);
    expect(t.frames).toBe(8);
    expect(t.durationSec).toBeCloseTo(0.36, 12);
    expect(t.avgFps).toMatchObject({ num: 200, den: 9 });
    expect(t.minFps).toMatchObject({ num: 25, den: 1 });
  });

  it('uses TimestampScale ticks for packet durations like ffmpeg 8.1.1 (TimestampScale 100000)', async () => {
    const blocks = Array.from({ length: 10 }, (_, k) => simpleBlock({ track: 1, rel: Math.round(k * 333.6667) }));
    const blob = file(ebmlHeader('matroska'), segment([info({ timestampScale: 100_000, duration: 3336.67 }), tracks({ number: 1, defaultDuration: 33366666 }), cluster(0, blocks)]));
    const r = await run(blob);
    const t = r.videoTracks[0];
    expect(r.formatDurationSec).toBe(0.333667);
    expect(t.timescale).toBe(10000);
    expect(t.durationSec).toBeCloseTo(0.3336, 12);
    expect(t.avgFps).toMatchObject({ num: 12500, den: 417 });
    expect(t.minFps).toMatchObject({ num: 5000, den: 167 });
    expect(t.maxFps).toMatchObject({ num: 10000, den: 333 });
    expect(t.avgFpsFfprobe).toBe('30000/1001');
  });

  it('subtracts CodecDelay from block timestamps', async () => {
    const blob = file(ebmlHeader(), segment([info(), tracks({ number: 1, defaultDuration: 40_000_000, codecDelay: 10_000_000 }), ...cfrClusters({ frames: 5, periodMs: 40 })]));
    const t = (await run(blob)).videoTracks[0];
    expect(t.startSec).toBeCloseTo(-0.01, 12);
    expect(t.avgFps).toMatchObject({ num: 25, den: 1 });
  });

  it('ignores image attachments and keeps them out of the video tracks', async () => {
    const att = el(ID.Attachments, el(ID.AttachedFile, concat(str(ID.FileName, 'cover.png'), str(ID.FileMediaType, 'image/png'), el(ID.FileData, new Uint8Array(500)))));
    const blob = file(ebmlHeader('matroska'), segment([info(), tracks({ number: 1, defaultDuration: 40_000_000 }), att, ...cfrClusters({ frames: 5, periodMs: 40 })]));
    const r = await run(blob);
    expect(r.videoTracks).toHaveLength(1);
    expect(r.warnings.join(' ')).toMatch(/1 attached image/);
  });
});

function floatBytes(v: number, len: 4 | 8): number[] {
  const b = new Uint8Array(len);
  const dv = new DataView(b.buffer);
  if (len === 4) dv.setFloat32(0, v);
  else dv.setFloat64(0, v);
  return Array.from(b);
}

describe('Tags', () => {
  it('parses DURATION per track with a 64-bit TagTrackUID and a language suffix', async () => {
    const uid = 0xfedcba9876543210n;
    const tags = el(ID.Tags, concat(durationTag(uid, '00:00:03.003000000'), durationTag(7, '01:02:03.5', 'DURATION-eng')));
    const blob = file(ebmlHeader(), segment([info({ duration: 3003 }), tracks({ number: 1, uid, defaultDuration: 33366666 }, { number: 2, uid: 7, defaultDuration: 40_000_000 }), tags, ...cfrClusters({ frames: 3, periodMs: 33.3667 })]));
    const r = await run(blob, { matroskaMode: 'header' });
    expect(r.videoTracks[0].durationSec).toBe(3.003);
    expect(r.videoTracks[0].provenance.durationSec).toBe('header');
    expect(r.videoTracks[1].durationSec).toBe(3723.5);
  });

  it('does not depend on the order of TagName and TagString and ignores nested tags', async () => {
    const simple = (name: string, value: string, nested: Uint8Array = new Uint8Array(0)): Uint8Array =>
      el(ID.SimpleTag, concat(str(ID.TagString, value), nested, str(ID.TagName, name)));
    const tag = el(ID.Tag, concat(el(ID.Targets, uint(ID.TagTrackUID, 1)), simple('ENCODER', 'x'), simple('DURATION', '00:00:02.000000000', simple('NOTE', 'n'))));
    const blob = file(ebmlHeader(), segment([info(), tracks({ number: 1, defaultDuration: 40_000_000 }), el(ID.Tags, tag), ...cfrClusters({ frames: 3, periodMs: 40 })]));
    const r = await run(blob, { matroskaMode: 'header' });
    expect(r.videoTracks[0].durationSec).toBe(2);
  });

  it('parses the DURATION string format', () => {
    expect(parseDurationTag('00:00:03.003000000')).toBe(3.003);
    expect(parseDurationTag('10:00:00.000000000')).toBe(36000);
    expect(parseDurationTag('garbage')).toBeNull();
  });
});

describe('SeekHead', () => {
  it('resolves positions relative to the Segment data start for elements beyond the head window', async () => {
    const voidBytes = el(ID.Void, new Uint8Array(200 * 1024));
    const clusters = cfrClusters({ frames: 30, periodMs: 40 });
    const infoEl = info({ duration: 1200 });
    const tracksEl = tracks({ number: 1, uid: 5, defaultDuration: 40_000_000 });
    const tagsEl = el(ID.Tags, durationTag(5, '00:00:01.200000000'));
    const probe = seekHead([
      [ID.Info, 0],
      [ID.Tracks, 0],
      [ID.Tags, 0],
    ]);
    const tail0 = probe.length + voidBytes.length + concat(...clusters).length;
    const head = seekHead([
      [ID.Info, tail0],
      [ID.Tracks, tail0 + infoEl.length],
      [ID.Tags, tail0 + infoEl.length + tracksEl.length],
    ]);
    expect(head.length).toBe(probe.length);
    const blob = file(ebmlHeader(), segment([head, voidBytes, ...clusters, infoEl, tracksEl, tagsEl]));
    const r = await run(blob, { matroskaMode: 'header' });
    expect(r.error).toBeNull();
    expect(r.formatDurationSec).toBe(1.2);
    expect(r.videoTracks[0].avgFpsFfprobe).toBe('25/1');
    expect(r.videoTracks[0].durationSec).toBe(1.2);
    expect(r.io.reads).toBeLessThanOrEqual(5);
    expect(r.io.bytesRead).toBeLessThanOrEqual(1024 * 1024);
    const exact = await run(blob, { matroskaMode: 'exact' });
    expect(exact.videoTracks[0].frames).toBe(30);
  });

  it('fails cleanly when no Tracks element can be found', async () => {
    const blob = file(ebmlHeader(), segment([info(), ...cfrClusters({ frames: 3, periodMs: 40 })]));
    const r = await run(blob);
    expect(r.error).toBe('no Tracks element found');
    expect(r.container).toBe('matroska');
  });
});

describe('unknown sizes, CRC-32, Void and truncation', () => {
  it('ends unknown-size Clusters at the next level-1 element in an unknown-size Segment', async () => {
    const clusters = cfrClusters({ frames: 90, periodMs: 1000 / 30, perCluster: 20, unknownSize: true });
    const cues = el(ID.Cues, el(ID.CuePoint, concat(uint(ID.CueTime, 0), el(ID.CueTrackPositions, concat(uint(ID.CueTrack, 1), uint(ID.CueClusterPosition, 0))))));
    const blob = file(ebmlHeader(), segment([info(), tracks({ number: 1, defaultDuration: 33333333 }), ...clusters, cues], true));
    const r = await run(blob);
    expect(r.warnings.join(' ')).toMatch(/unknown size/);
    expect(r.formatDurationSec).toBeNull();
    expect(r.videoTracks[0].frames).toBe(90);
    expect(r.videoTracks[0].avgFps?.value).toBeCloseTo(90 / (2966 + 33) * 1000, 9);
  });

  it('skips CRC-32 and Void elements at every level', async () => {
    const crc = el(ID.CRC32, [1, 2, 3, 4]);
    const v = el(ID.Void, new Uint8Array(10));
    const blob = file(
      ebmlHeader(),
      segment([crc, v, info(), v, tracks({ number: 1, defaultDuration: 40_000_000 }), el(ID.Cluster, concat(crc, uint(ID.Timestamp, 0), v, simpleBlock({ track: 1, rel: 0 }), v, simpleBlock({ track: 1, rel: 40 }))), v]),
    );
    const t = (await run(blob)).videoTracks[0];
    expect(t.frames).toBe(2);
    expect(t.avgFps).toMatchObject({ num: 25, den: 1 });
  });

  it('counts only complete blocks of a truncated file and warns', async () => {
    const full = concat(ebmlHeader(), segment([info({ duration: 3000 }), tracks({ number: 1, defaultDuration: 40_000_000 }), ...cfrClusters({ frames: 75, periodMs: 40, payload: 200 })]));
    const r = await run(file(full.subarray(0, full.length - 5000)));
    const t = r.videoTracks[0];
    expect(t.frames).toBeGreaterThan(40);
    expect(t.frames).toBeLessThan(60);
    expect(r.warnings.join(' ')).toMatch(/truncated file/);
    expect(r.warnings.join(' ')).toMatch(/Info Duration 3\.000 s exceeds the last block/);
  });

  it('resynchronises on the next valid Cluster after garbage', async () => {
    const [c1, c2] = cfrClusters({ frames: 20, periodMs: 40, perCluster: 10 });
    const garbage = new Uint8Array(64).fill(0);
    garbage.set([0x1f, 0x43, 0xb6, 0x75, 0x85, 0, 0, 0, 0, 0], 10);
    const blob = file(ebmlHeader(), segment([info(), tracks({ number: 1, defaultDuration: 40_000_000 }), c1, garbage, c2], true));
    const r = await run(blob);
    expect(r.videoTracks[0].frames).toBe(20);
    expect(r.warnings.join(' ')).toMatch(/skipped 64 bytes of invalid data/);
  });

  it('rejects files without a Segment', async () => {
    const r = await run(file(ebmlHeader(), el(ID.Void, new Uint8Array(4))));
    expect(r.error).toBe('no Segment element');
  });
});

describe('modes', () => {
  it('never outputs an average or a frame count from sampled data', async () => {
    const r = await run(simpleFile({ frames: 300, duration: 10000 }), { matroskaMode: 'probe' });
    const t = r.videoTracks[0];
    expect(r.scan).toBe('probe');
    expect(t.avgFps).toBeNull();
    expect(t.frames).toBeNull();
    expect(t.presentedFrames).toBeNull();
    expect(t.provenance.minFps).toBe('sampled');
    expect(t.minFps).not.toBeNull();
    expect(t.durationSec).toBeCloseTo(9.999, 9);
    expect(t.warnings.join(' ')).toMatch(/about 300 frames \(estimated/);
  });

  it('header mode reads at most the head window and leaves measured fields empty', async () => {
    const r = await run(simpleFile({ frames: 300, duration: 10000 }), { matroskaMode: 'header' });
    const t = r.videoTracks[0];
    expect(r.scan).toBe('header');
    expect(r.io.reads).toBe(1);
    expect(t.avgFps).toBeNull();
    expect(t.minFps).toBeNull();
    expect(t.isVfr).toBeNull();
    expect(t.nominalFps).toMatchObject({ num: 30, den: 1, kind: 'declared' });
  });

  it('auto runs exact within the budget and probe beyond it', async () => {
    const small = await run(simpleFile({ frames: 60 }), { matroskaMode: 'auto' });
    expect(small.scan).toBe('exact');
    const tight = await run(simpleFile({ frames: 60 }), { matroskaMode: 'auto', exactBudgetMs: 0 });
    expect(tight.scan).toBe('probe');
    expect(tight.warnings.join(' ')).toMatch(/exact block scan skipped/);
  });

  it('keeps the exact frame count but skips per-frame statistics above maxExpandedSamples', async () => {
    const t = (await run(simpleFile({ frames: 30 }), { maxExpandedSamples: 10 })).videoTracks[0];
    expect(t.frames).toBe(30);
    expect(t.avgFps).toBeNull();
    expect(t.minFps).toBeNull();
    expect(t.warnings.join(' ')).toMatch(/per-frame statistics skipped/);
  });

  it('plans the cheaper of 4 KiB and 1 MiB windows under the cost model', () => {
    const opts = resolveOptions();
    const region = 100 * 1024 * 1024;
    const frames = (bytes: number): { blocks: number; large: number; smallBytes: number } => ({
      blocks: region / bytes,
      large: bytes >= 4096 ? region / bytes : 0,
      smallBytes: bytes >= 4096 ? 0 : region,
    });
    expect(planExactScan(region, frames(512 * 1024), opts)).toMatchObject({ window: 4096, reads: 200 });
    expect(planExactScan(region, frames(64 * 1024), opts)).toMatchObject({ window: 1024 * 1024, reads: 100, bytes: region });
    expect(planExactScan(region, frames(8 * 1024), opts)).toMatchObject({ window: 1024 * 1024, reads: 100, bytes: region });
    expect(planExactScan(region, null, opts)).toMatchObject({ window: 1024 * 1024, reads: 100 });
    expect(planExactScan(region, frames(512 * 1024), { ...opts, costModel: { ...opts.costModel, perReadMs: 0.01 } }).window).toBe(4096);
  });

  it('reports progress during exact scans and honours abort', async () => {
    const blob = simpleFile({ frames: 3000, periodMs: 1000 / 30 });
    const seen: number[] = [];
    await run(blob, { readAhead: { head: 4096, matroskaScan: 4096 }, onProgress: (p) => seen.push(p.done) });
    expect(seen.length).toBeGreaterThan(3);
    expect(seen[seen.length - 1]).toBe(Math.max(...seen));
    const ctl = new AbortController();
    const aborting = run(blob, {
      signal: ctl.signal,
      readAhead: { head: 4096, matroskaScan: 4096 },
      onProgress: (p) => {
        if (p.done > 0) ctl.abort();
      },
    });
    await expect(aborting).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('merges sampled runs without deltas across runs', () => {
    const a = analyzeTimeline({ timescale: 1000, pts: [0, 33, 67, 100, 133], tickQuantized: true });
    const b = analyzeTimeline({ timescale: 1000, pts: [5000, 5033, 5067, 5100], tickQuantized: true });
    const m = mergeRunStats(1000, [a, b]);
    expect(m.isVfr).toBe(false);
    expect(m.timestampsQuantized).toBe(true);
    expect(m.minFps).toMatchObject({ num: 500, den: 17 });
    expect(m.maxFps).toMatchObject({ num: 1000, den: 33 });
  });
});
