import { openAsBlob, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { isoBmffFixtureSet } from '../../scripts/compare/layout.ts';
import { analyze } from '../../src/core/analyze.ts';
import type { FileResult, VideoTrackResult } from '../../src/core/types.ts';
import { analyzeHeader, warningCodesOf, type HeaderResult } from '../../src/header/index.ts';
import { FILES_DIR } from '../helpers/fixtures.ts';
import { bytes, ftyp, mdatHeader, mfra, moof, moov, mvex, recording, sidx, virtualSource, type VirtualSource } from '../helpers/iso-builder.ts';

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
