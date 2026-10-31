import { openAsBlob, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { isoBmffFixtureSet } from '../../scripts/compare/layout.ts';
import { analyze } from '../../src/core/analyze.ts';
import type { FileResult, VideoTrackResult } from '../../src/core/types.ts';
import { analyzeHeader, warningCodesOf, type HeaderResult } from '../../src/header/index.ts';
import { FILES_DIR } from '../helpers/fixtures.ts';
import { bytes, ftyp, fullBox, mdatHeader, mfra, moof, moov, mvex, recording, sidx, tag, u32, virtualSource, zeros, type FragmentSpec, type Segment, type VirtualSource } from '../helpers/iso-builder.ts';

const TRACK_FIELDS = ['codecName', 'fourccOrCodecId', 'width', 'height', 'rotation', 'frames', 'isStill', 'enabled', 'durationSec', 'startSec', 'avgFpsFfprobe', 'sampleAspectRatio', 'displayWidth', 'displayHeight'] as const;
const FILE_FIELDS = ['container', 'brand', 'formatDurationSec', 'layout', 'error', 'errorCode', 'audioTrackCount', 'primaryTrackId'] as const;
const AUDIO_LONGER = ['fmp4_audio_longer.mp4', 'fmp4_audio_longer_sidx.mp4'];
const NO_INDEX = ['fmp4_dash_single_file.mp4', 'fmp4_dash_concat_segments.mp4', 'rec_chromium_h264_sliced.mp4', 'rec_chromium_vp9_sliced.mp4', 'fmp4_missing_fragment.mp4', 'corrupt_fmp4_truncated_mid_fragment.mp4'];

const pick = (o: object, keys: readonly string[]): Record<string, unknown> => Object.fromEntries(keys.map((k) => [k, (o as Record<string, unknown>)[k]]));

interface Pair {
  name: string;
  header: HeaderResult;
  full: FileResult;
  fragmented: boolean;
}

const names = readdirSync(FILES_DIR).sort();
const iso = await isoBmffFixtureSet(names, (n) => join(FILES_DIR, n));
const pairs: Pair[] = [];
for (const name of iso) {
  const blob = await openAsBlob(join(FILES_DIR, name));
  const full = await analyze(blob, name, {});
  pairs.push({ name, header: await analyzeHeader(blob, { name }), full, fragmented: full.layout?.kind === 'fragmented' });
}

describe('header mode against full mode on the computed ISO BMFF set', () => {
  test('the set holds both layouts', () => {
    expect(pairs.filter((p) => !p.fragmented).length).toBeGreaterThan(50);
    expect(pairs.filter((p) => p.fragmented).length).toBeGreaterThan(15);
    expect(pairs.every((p) => p.header.scan === 'header')).toBe(true);
  });

  test('every non-fragmented file gives the full-mode fields', () => {
    for (const { name, header, full } of pairs.filter((p) => !p.fragmented)) {
      expect(pick(header, FILE_FIELDS), name).toEqual(pick(full, FILE_FIELDS));
      expect(warningCodesOf(header), name).toEqual(warningCodesOf(full));
      expect(header.videoTracks.map((t) => pick(t, TRACK_FIELDS)), name).toEqual(full.videoTracks.map((t) => pick(t, TRACK_FIELDS)));
      header.videoTracks.forEach((t: VideoTrackResult, i) => {
        if (full.videoTracks[i].provenance.avgFps === 'header') expect(t.avgFps, `${name} track ${t.trackId}`).toEqual(full.videoTracks[i].avgFps);
      });
    }
  });

  test('every fragmented file gives the full-mode isStill, enabled and layout, and never a shorter format duration', () => {
    for (const { name, header, full } of pairs.filter((p) => p.fragmented)) {
      expect(header.layout, name).toEqual(full.layout);
      if (full.error === null) expect(header.videoTracks.length, name).toBe(full.videoTracks.length);
      expect([null, 'no-duration', full.errorCode], name).toContain(header.errorCode);
      expect(header.videoTracks.map((t) => [t.trackId, t.isStill, t.enabled]), name).toEqual(full.videoTracks.map((t) => [t.trackId, t.isStill, t.enabled]));
      if (header.formatDurationSec !== null) expect(header.formatDurationSec, name).toBe(full.formatDurationSec);
      else expect(header.errorCode !== null || header.warnings.some((w) => w.startsWith('format duration unresolved: track ')), name).toBe(true);
      header.videoTracks.forEach((t, i) => {
        expect([t.frames, t.avgFps, t.avgFpsFfprobe, t.startSec, t.presentedFrames, t.rFpsFfprobe], name).toEqual([null, null, null, null, null, null]);
        if (t.durationSec !== null) expect(t.durationSec, `${name} track ${t.trackId}`).toBe(full.videoTracks[i].durationSec);
      });
    }
  });

  test('a sound track that outlasts the video sets the format duration as in full mode', () => {
    for (const name of AUDIO_LONGER) {
      const p = pairs.find((x) => x.name === name)!;
      expect(p.header.error, name).toBeNull();
      expect(p.header.formatDurationSec, name).toBe(p.full.formatDurationSec);
      expect(p.header.formatDurationSec!, name).toBeGreaterThan(p.header.videoTracks[0].durationSec!);
    }
  });

  test('a fragmented file without an index ends in no-duration with its tracks', () => {
    for (const name of NO_INDEX) {
      const p = pairs.find((x) => x.name === name)!;
      expect(p.header, name).toMatchObject({ errorCode: 'no-duration', error: 'incomplete header: fragmented file without a sidx, mfra or mehd duration', formatDurationSec: null });
      expect(p.header.videoTracks.length, name).toBe(p.full.videoTracks.length);
      expect(p.header.primaryTrackId, name).toBe(p.full.primaryTrackId);
    }
  });

  test('every header track keeps the per-sample fields at their empty values', () => {
    for (const { name, header } of pairs) {
      for (const t of header.videoTracks) {
        expect([t.presentedFrames, t.minFps, t.maxFps, t.nominalFps, t.dominantFps, t.isVfr, t.rFpsFfprobe, t.medianFrameInterval, t.rateProfile ?? null], name).toEqual([null, null, null, null, null, null, null, null, null]);
        expect([t.vfrRatio, t.distinctDeltas, t.duplicateTimestamps], name).toEqual([0, 0, 0]);
        for (const k of ['presentedFrames', 'minFps', 'maxFps', 'isVfr', 'duplicateTimestamps', 'medianFrameInterval', 'nominalFps', 'dominantFps'] as const) expect(t.provenance[k], `${name} ${k}`).toBeUndefined();
      }
    }
  });
});

function hybrid(withSidx: boolean): VirtualSource {
  const head = bytes(ftyp('iso5'), moov([{ id: 1, timescale: 15360, samples: [[30, 512]] }], [mvex({ trex: [{ id: 1, duration: 512 }] })]));
  const m = moof(1, [{ id: 1, baseDts: 30 * 512, count: 30, duration: 512, cts: 1024 }], 3000);
  const s = withSidx ? sidx(1, 15360, 30 * 512 + 1024, [[m.length + 8 + 3000, 30 * 512]]) : bytes();
  const at = head.length + 8 + 100_000 + s.length;
  return virtualSource([head, mdatHeader(100_000), { zeros: 100_000 }, s, m, mdatHeader(3000), { zeros: 3000 }, mfra([{ id: 1, offsets: [at] }])]);
}

function oneFrame(): VirtualSource {
  const head = bytes(ftyp('iso5'), moov([{ id: 1, timescale: 15360 }], [mvex({ trex: [{ id: 1, duration: 512 }] })]));
  return virtualSource([head, moof(1, [{ id: 1, baseDts: 0, count: 1, duration: 512 }], 500), mdatHeader(500), { zeros: 500 }, mfra([{ id: 1, offsets: [head.length] }])]);
}

function withText(fragments: number, textMs: number): VirtualSource {
  const head = bytes(ftyp('iso5'), moov([{ id: 1, timescale: 15360 }, { id: 2, handler: 'text', timescale: 1000 }], [mvex({ trex: [{ id: 1, duration: 512 }, { id: 2, duration: 1000 }] })]));
  const segments: Segment[] = [head];
  const offsets: number[] = [];
  let at = head.length;
  for (let i = 0; i < fragments; i++) {
    const trafs: FragmentSpec[] = [{ id: 1, baseDts: i * 30 * 512, count: 30, duration: 512 }];
    if (i === 0) trafs.push({ id: 2, baseDts: 0, count: 1, duration: textMs });
    const m = moof(i + 1, trafs, 100_000);
    offsets.push(at);
    segments.push(m, mdatHeader(100_000), { zeros: 100_000 });
    at += m.length + 8 + 100_000;
  }
  segments.push(mfra([{ id: 1, offsets }, { id: 2, offsets: [offsets[0]] }]));
  return virtualSource(segments);
}

function auxiliary(mehd: number | null, textInIndex: boolean): VirtualSource {
  const head = bytes(ftyp('iso5'), moov([{ id: 1, timescale: 15360 }, { id: 2, handler: 'soun', timescale: 48000 }, { id: 3, handler: 'text', timescale: 1000 }], [mvex({ trex: [{ id: 1, duration: 512 }, { id: 2, duration: 1024 }, { id: 3, duration: 1000 }], mehd })]));
  const segments: Segment[] = [head];
  const offsets: number[] = [];
  let at = head.length;
  for (let i = 0; i < 6; i++) {
    const trafs: FragmentSpec[] = [{ id: 1, baseDts: i * 30 * 512, count: 30, duration: 512, cts: 1024 }, { id: 2, baseDts: i * 48000, count: 1, duration: 48000 }];
    if (i === 0) trafs.push({ id: 3, baseDts: 0, count: 1, duration: 6000 });
    const m = moof(i + 1, trafs, 100_000);
    offsets.push(at);
    segments.push(m, mdatHeader(100_000), { zeros: 100_000 });
    at += m.length + 8 + 100_000;
  }
  const entries = [{ id: 1, offsets }, { id: 2, offsets }];
  if (textInIndex) entries.push({ id: 3, offsets: [offsets[0]] });
  segments.push(mfra(entries));
  return virtualSource(segments);
}

function hybridWithText(): VirtualSource {
  const tracks = [{ id: 1, timescale: 15360, samples: [[30, 512]] as Array<[number, number]> }, { id: 2, handler: 'soun' as const, timescale: 48000, samples: [[47, 1024]] as Array<[number, number]> }, { id: 3, handler: 'text' as const, timescale: 1000, samples: [[1, 900]] as Array<[number, number]> }];
  const head = bytes(ftyp('iso5'), moov(tracks, [mvex({ trex: [{ id: 1, duration: 512 }, { id: 2, duration: 1024 }, { id: 3, duration: 1000 }] })]));
  const segments: Segment[] = [head, mdatHeader(100_000), { zeros: 100_000 }];
  const offsets: number[] = [];
  let at = head.length + 8 + 100_000;
  for (let i = 1; i < 4; i++) {
    const m = moof(i, [{ id: 1, baseDts: i * 30 * 512, count: 30, duration: 512, cts: 1024 }, { id: 2, baseDts: i * 47 * 1024, count: 47, duration: 1024 }], 100_000);
    offsets.push(at);
    segments.push(m, mdatHeader(100_000), { zeros: 100_000 });
    at += m.length + 8 + 100_000;
  }
  segments.push(mfra([{ id: 1, offsets }, { id: 2, offsets }]));
  return virtualSource(segments);
}

function coveringSidx(fragments: number): VirtualSource {
  const head = bytes(ftyp('cmfc'), moov([{ id: 1, timescale: 15360 }, { id: 2, handler: 'soun', timescale: 48000 }], [mvex({ trex: [{ id: 1, duration: 512 }, { id: 2, duration: 1024 }] })]));
  const pieces: Segment[] = [];
  const video: Array<[number, number]> = [];
  const audio: Array<[number, number]> = [];
  for (let i = 0; i < fragments; i++) {
    const frames = i === fragments - 1 ? 71 : 70;
    const m = moof(i + 1, [{ id: 1, baseDts: i * 45 * 512, count: 45, duration: 512 }, { id: 2, baseDts: i * 70 * 1024, count: frames, duration: 1024 }], 20_000);
    pieces.push(m, mdatHeader(20_000), { zeros: 20_000 });
    video.push([m.length + 8 + 20_000, 45 * 512]);
    audio.push([m.length + 8 + 20_000, 72_000]);
  }
  const second = sidx(2, 48000, 0, audio);
  const first = sidx(1, 15360, 0, video, second.length);
  return virtualSource([head, first, second, ...pieces]);
}

function sidxBefore(segment: (i: number) => boolean): VirtualSource {
  const head = bytes(ftyp('iso5'), moov([{ id: 1, timescale: 15360 }], [mvex({ trex: [{ id: 1, duration: 512 }] })]));
  const segments: Segment[] = [head];
  const offsets: number[] = [];
  let at = head.length;
  for (let i = 0; i < 6; i++) {
    const m = moof(i + 1, [{ id: 1, baseDts: i * 30 * 512, count: 30, duration: 512, cts: 1024 }], 100_000);
    const s = segment(i) ? sidx(1, 15360, i * 30 * 512 + 1024, [[m.length + 8 + 100_000, 30 * 512]]) : bytes();
    segments.push(s, m, mdatHeader(100_000), { zeros: 100_000 });
    offsets.push(at + s.length);
    at += s.length + m.length + 8 + 100_000;
  }
  segments.push(mfra([{ id: 1, offsets }]));
  return virtualSource(segments);
}

function emsgInSegment(segment: number, emsgBytes = 0): VirtualSource {
  const head = bytes(ftyp('iso5'), moov([{ id: 1, timescale: 15360 }], [mvex({ trex: [{ id: 1, duration: 512 }] })]));
  const segments: Segment[] = [head];
  const offsets: number[] = [];
  let at = head.length;
  for (let i = 0; i < 6; i++) {
    const m = moof(i + 1, [{ id: 1, baseDts: i * 30 * 512, count: 30, duration: 512, cts: 1024 }], 100_000);
    const emsg = i === segment ? fullBox('emsg', 0, 0, tag('urn:x '), tag('v '), u32(1000), u32(0), u32(10), u32(i), zeros(emsgBytes)) : bytes();
    const s = sidx(1, 15360, i * 30 * 512 + 1024, [[emsg.length + m.length + 8 + 100_000, 30 * 512]]);
    segments.push(s, emsg, m, mdatHeader(100_000), { zeros: 100_000 });
    offsets.push(at + s.length + emsg.length);
    at += s.length + emsg.length + m.length + 8 + 100_000;
  }
  segments.push(mfra([{ id: 1, offsets }]));
  return virtualSource(segments);
}

const VIRTUAL: Array<[string, () => VirtualSource]> = [
  ['a single moof with an mfra', () => recording({ fragments: 1, mdatBytes: 300_000 }).source],
  ['a single moof with longer audio', () => recording({ fragments: 1, mdatBytes: 300_000, audio: true, audioLonger: 9 }).source],
  ['a moov with every sample, an mdat and an empty mfra', () => virtualSource([bytes(ftyp('iso5'), moov([{ id: 1, timescale: 15360, samples: [[60, 512]] }], [mvex({ trex: [{ id: 1, duration: 512 }] })])), mdatHeader(200_000), { zeros: 200_000 }, mfra([])])],
  ['a one-frame fragment', oneFrame],
  ['composition offsets with a sidx per fragment and an mfra', () => recording({ fragments: 4, mdatBytes: 200_000, cts: 1024, sidx: 'fragment' }).source],
  ['composition offsets with a global sidx and an mfra', () => recording({ fragments: 4, mdatBytes: 200_000, cts: 1024, sidx: true }).source],
  ['composition offsets with separate moofs and shorter audio in one fragment', () => recording({ fragments: 1, mdatBytes: 150_000, cts: 1024, audio: true, audioShorter: 10, separate: true }).source],
  ['a hybrid file with a sidx after its first mdat', () => hybrid(true)],
  ['a hybrid file without a sidx', () => hybrid(false)],
  ['an emsg between the sidx and the moof of the last segment', () => emsgInSegment(5)],
  ['an emsg between the sidx and the moof of the first segment', () => emsgInSegment(0)],
  ['a sidx before every moof but the first', () => sidxBefore((i) => i > 0)],
  ['a sidx before the last moof only', () => sidxBefore((i) => i === 5)],
  ['a text track that ends 0.5 s after the video', () => withText(1, 1500)],
  ['a text track that ends 1.5 s after the video', () => withText(1, 2500)],
  ['a text track in the first of three moofs that ends 0.5 s after the video', () => withText(3, 3500)],
  ['a text track of one empty sample in the first of three moofs', () => withText(3, 0)],
];

describe('header mode against full mode on virtual sources', () => {
  test.each(VIRTUAL)('%s gives the full-mode durations, isStill, enabled and layout', async (label, open) => {
    const full = await analyze(open(), label, {});
    const header = await analyzeHeader(open());
    expect(full.error, label).toBeNull();
    expect(pick(header, ['formatDurationSec', 'layout', 'error', 'errorCode', 'primaryTrackId']), label).toEqual(pick(full, ['formatDurationSec', 'layout', 'error', 'errorCode', 'primaryTrackId']));
    expect(header.videoTracks.map((t) => [t.trackId, t.durationSec, t.isStill, t.enabled]), label).toEqual(full.videoTracks.map((t) => [t.trackId, t.durationSec, t.isStill, t.enabled]));
  });

  test('separate moofs whose sound track starts outside the first moof get no format duration rather than a short one', async () => {
    const rec = recording({ fragments: 3, mdatBytes: 150_000, cts: 1024, audio: true, audioShorter: 10, separate: true });
    const full = await analyze(rec.source, 'separate.mp4', {});
    const header = await analyzeHeader(rec.source);
    expect(header.error).toBeNull();
    expect(header.videoTracks[0].durationSec).toBe(full.videoTracks[0].durationSec);
    expect(header.formatDurationSec).toBeNull();
    expect(header.warnings).toContain('format duration unresolved: track 2');
  });

  test('a sidx before the last moof that the search window misses gives no duration rather than a short one', async () => {
    const full = await analyze(emsgInSegment(5, 8000), 'emsg.mp4', {});
    const header = await analyzeHeader(emsgInSegment(5, 8000));
    expect(full.videoTracks[0].durationSec).toBeCloseTo(6 + 1024 / 15360, 9);
    expect(header).toMatchObject({ errorCode: 'no-duration', formatDurationSec: null });
    expect(header.videoTracks[0].durationSec).toBeNull();
  });

  test('a text track that outlasts the video sets the format duration as in full mode', async () => {
    for (const [fragments, textMs] of [[1, 1500], [3, 3500]]) {
      const full = await analyze(withText(fragments, textMs), 'text.mp4', {});
      const header = await analyzeHeader(withText(fragments, textMs));
      expect(full.formatDurationSec, String(fragments)).toBe(textMs / 1000);
      expect(header.formatDurationSec, String(fragments)).toBe(full.formatDurationSec);
      expect(header.videoTracks[0].durationSec, String(fragments)).toBe(fragments);
    }
  });

  test('a text track whose last fragment comes before the walk of the video keeps the video span under a read limit, with the warning', async () => {
    const full = await analyze(withText(3, 3500), 'text.mp4', {});
    const header = await analyzeHeader(withText(3, 3500), { limits: { maxReads: 3 } });
    expect(header.error).toBeNull();
    expect(header.io.reads).toBe(3);
    expect(header.videoTracks[0].durationSec).toBe(full.videoTracks[0].durationSec);
    expect(header.formatDurationSec).toBe(full.videoTracks[0].durationSec);
    expect(header.warnings).toContain('format duration unresolved: track 2');
  });

  test('a text track next to a covering sidx in header mode keeps the video span, with the warning', async () => {
    const head = bytes(ftyp('iso5'), moov([{ id: 1, timescale: 15360 }, { id: 2, handler: 'text', timescale: 1000 }], [mvex({ trex: [{ id: 1, duration: 512 }, { id: 2, duration: 1000 }] })]));
    const m = moof(1, [{ id: 1, baseDts: 0, count: 30, duration: 512 }, { id: 2, baseDts: 0, count: 1, duration: 1500 }], 3000);
    const open = (): VirtualSource => virtualSource([head, sidx(1, 15360, 0, [[m.length + 8 + 3000, 30 * 512]]), m, mdatHeader(3000), { zeros: 3000 }]);
    const full = await analyze(open(), 'text.mp4', {});
    const header = await analyzeHeader(open(), { fragmentedDuration: 'header' });
    expect(full.formatDurationSec).toBe(1.5);
    expect(header.error).toBeNull();
    expect(header.videoTracks[0].durationSec).toBe(1);
    expect(header.formatDurationSec).toBe(1);
    expect(header.warnings).toContain('format duration unresolved: track 2');
  });

  test('a text track that resolves only from mehd or not at all keeps the span of B-frame video and sound', async () => {
    for (const mehd of [6000, null]) {
      const label = `mehd ${mehd}`;
      const full = await analyze(auxiliary(mehd, false), 'aux.mp4', {});
      const header = await analyzeHeader(auxiliary(mehd, false));
      expect(full.formatDurationSec, label).toBe(6.066667);
      expect(header.error, label).toBeNull();
      expect(header.formatDurationSec, label).toBe(full.formatDurationSec);
      expect(header.videoTracks[0].durationSec, label).toBe(full.videoTracks[0].durationSec);
      expect(header.videoTracks[0].provenance.durationSec, label).toBe('header');
      expect(header.warnings, label).toContain('format duration unresolved: track 3');
      expect(warningCodesOf(header), label).toEqual([]);
    }
  });

  test('a hybrid file with a text track whose only sample is in the moov gets the full-mode format duration', async () => {
    const full = await analyze(hybridWithText(), 'hybrid.mp4', {});
    const header = await analyzeHeader(hybridWithText());
    expect(header.error).toBeNull();
    expect(header.formatDurationSec).toBe(full.formatDurationSec);
    expect(header.videoTracks[0].durationSec).toBe(full.videoTracks[0].durationSec);
    expect(header.warnings).toContain('format duration unresolved: track 3');
  });

  test('a text track whose second walk hits a read limit keeps the span of B-frame video and sound', async () => {
    const full = await analyze(auxiliary(6000, true), 'aux.mp4', {});
    expect((await analyzeHeader(auxiliary(6000, true))).warnings).toEqual([]);
    for (const maxReads of [3, 4, 5, 6]) {
      const header = await analyzeHeader(auxiliary(6000, true), { limits: { maxReads } });
      expect(header.error, String(maxReads)).toBeNull();
      expect(header.io.reads, String(maxReads)).toBe(maxReads);
      expect(header.formatDurationSec, String(maxReads)).toBe(full.formatDurationSec);
      expect(header.videoTracks[0].provenance.durationSec, String(maxReads)).toBe('header');
      expect(header.warnings, String(maxReads)).toEqual([`fragment index not read: limit reached: maxReads ${maxReads}`, 'format duration unresolved: track 3']);
    }
  });

  test('a covering sidx of one fragment gives the later end of its sound fragment in both modes, also with a cut moof', async () => {
    const full = await analyze(coveringSidx(1), 'cmaf.mp4', {});
    expect(full.formatDurationSec).toBe(1.514667);
    for (const options of [{}, { fragmentedDuration: 'header' as const }, { fragmentedDuration: 'header' as const, readAhead: { head: 1024 } }]) {
      const header = await analyzeHeader(coveringSidx(1), options);
      expect(header.error, JSON.stringify(options)).toBeNull();
      expect(header.formatDurationSec, JSON.stringify(options)).toBe(full.formatDurationSec);
      expect(header.videoTracks[0].durationSec, JSON.stringify(options)).toBe(1.5);
    }
  });

  test('a covering sidx of several fragments gives its end where only the last fragment runs past it, as ffprobe reads it', async () => {
    const full = await analyze(coveringSidx(3), 'cmaf.mp4', {});
    const header = await analyzeHeader(coveringSidx(3));
    expect(full.formatDurationSec).toBe(4.501333);
    expect(header.error).toBeNull();
    expect(header.formatDurationSec).toBe(4.5);
    expect(header.videoTracks[0].durationSec).toBe(full.videoTracks[0].durationSec);
    expect(header.io.reads).toBe(1);
  });

  test('a hybrid file whose last moof is inside the tail resolves within three reads', async () => {
    const full = await analyze(hybrid(false), 'hybrid.mp4', {});
    const header = await analyzeHeader(hybrid(false), { limits: { maxReads: 3 } });
    expect(header).toMatchObject({ error: null, formatDurationSec: full.formatDurationSec });
    expect(header.videoTracks[0].durationSec).toBe(full.videoTracks[0].durationSec);
    expect(header.io.reads).toBe(3);
  });

  test('a first moof that the head window cuts is read for the start offsets', async () => {
    const name = 'fmp4_global_sidx_bframes.mp4';
    const blob = await openAsBlob(join(FILES_DIR, name));
    const full = pairs.find((p) => p.name === name)!.full;
    for (const head of [1024, 4096]) {
      const r = await analyzeHeader(blob, { readAhead: { head }, limits: { maxReads: Number.POSITIVE_INFINITY } });
      expect(r.formatDurationSec, String(head)).toBe(full.formatDurationSec);
    }
  });
});

describe('header mode against full mode on virtual recordings', () => {
  test('a recording with longer audio gets the full-mode format duration, or null with the unresolved-track warning', async () => {
    const rec = recording({ fragments: 5, mdatBytes: 1024 * 1024, audio: true, audioLonger: 30 });
    const full = await analyze(rec.source, 'rec.mp4', {});
    const header = await analyzeHeader(rec.source);
    expect(header.error).toBeNull();
    expect(header.formatDurationSec).toBe(full.formatDurationSec);
    expect(header.videoTracks[0].durationSec).toBe(full.videoTracks[0].durationSec);
    const limited = await analyzeHeader(rec.source, { limits: { maxReads: 2 } });
    expect(limited.formatDurationSec === full.formatDurationSec || limited.errorCode !== null || limited.warnings.some((w) => w.startsWith('format duration unresolved: track '))).toBe(true);
  });
});
