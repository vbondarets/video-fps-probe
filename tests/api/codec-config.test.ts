import { openAsBlob, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { isoBmffFixtureSet } from '../../scripts/compare/layout.ts';
import { analyze } from '../../src/analyze.ts';
import { warningCodesOf } from '../../src/api/codes.ts';
import { aspectOf } from '../../src/aspect/index.ts';
import { colorOf } from '../../src/color/index.ts';
import { analyze as engineAnalyze } from '../../src/core/analyze.ts';
import { MOOV_SUSPECT_CAP } from '../../src/core/isobmff/build.ts';
import { analyzeIsoBmff } from '../../src/core/isobmff/index.ts';
import type { FileResult, VideoTrackResult } from '../../src/core/types.ts';
import { analyzeHeader } from '../../src/header/index.ts';
import { createProbe } from '../../src/probe.ts';
import { singleContainerEngine } from '../../src/worker/single.ts';
import { FILES_DIR } from '../helpers/fixtures.ts';

const CONFIG = '../../src/core/isobmff/config.ts';
const UNBOUNDED = { maxBytes: Infinity, maxReads: Infinity, maxMs: Infinity, maxTracks: Infinity, maxTopLevelBoxes: Infinity };
const fixture = (name: string) => openAsBlob(join(FILES_DIR, name));

function withoutConfig(r: FileResult) {
  const videoTracks = r.videoTracks.map((t) => {
    const copy = { ...t };
    delete copy.codecConfig;
    return copy;
  });
  return { ...r, io: { reads: r.io.reads, bytesRead: r.io.bytesRead }, videoTracks };
}

const metadataOf = (t: VideoTrackResult) => ({ color: colorOf(t), aspect: aspectOf(t) });

function postedBytes(message: unknown): number {
  const buffers = new Set<ArrayBufferLike>();
  const seen = new Set<object>();
  const visit = (value: unknown): void => {
    if (typeof value !== 'object' || value === null || seen.has(value)) return;
    seen.add(value);
    if (ArrayBuffer.isView(value)) buffers.add(value.buffer);
    else if (value instanceof ArrayBuffer) buffers.add(value);
    else for (const v of Object.values(value)) visit(v);
  };
  visit(structuredClone(message));
  let total = 0;
  for (const b of buffers) total += b.byteLength;
  return total;
}

afterEach(() => {
  vi.doUnmock(CONFIG);
  vi.resetModules();
});

const names = readdirSync(FILES_DIR).sort();
const iso = await isoBmffFixtureSet(names, (n) => join(FILES_DIR, n));

async function headerTracks(blob: Blob, name: string): Promise<Map<number, VideoTrackResult>> {
  const header = await analyzeHeader(blob, { name, codecConfig: true, limits: UNBOUNDED });
  return new Map(header.videoTracks.map((t) => [t.trackId, t]));
}

describe('analyze with codecConfig on MP4 and MOV', () => {
  test(`captures the boxes analyzeHeader captures, with no extra read, on every fixture of the computed ISO BMFF set (${iso.length} files)`, async () => {
    expect(iso.length).toBeGreaterThan(100);
    let captured = 0;
    for (const name of iso) {
      const blob = await fixture(name);
      const plain = await analyze(blob, { name });
      const r = await analyze(blob, { name, codecConfig: true });
      expect(withoutConfig(r), name).toEqual(withoutConfig(plain));
      const fromHeader = await headerTracks(blob, name);
      for (const t of r.videoTracks) {
        expect(t.codecConfig?.family, `${name} track ${t.trackId}`).toBe('isobmff');
        expect(t.codecConfig, `${name} track ${t.trackId}`).not.toHaveProperty('moov');
        if (fromHeader.has(t.trackId)) expect(t.codecConfig, `${name} track ${t.trackId}`).toEqual(fromHeader.get(t.trackId)!.codecConfig);
        captured++;
      }
    }
    expect(captured).toBeGreaterThan(100);
  });

  test('a box cutting chunk that fails to load keeps the view of the moov, which color and aspect read', async () => {
    vi.resetModules();
    vi.doMock(CONFIG, async () => {
      throw new TypeError('Failed to fetch dynamically imported module');
    });
    const failing = (await import('../../src/analyze.ts')).analyze;
    const blob = await fixture('hdr10_hevc10.mp4');
    const plain = await failing(blob);
    const r = await failing(blob, { codecConfig: true });
    expect(withoutConfig(r)).toEqual(withoutConfig(plain));
    expect(warningCodesOf(r)).toEqual([]);
    const t = r.videoTracks[0];
    expect(t.codecConfig).toMatchObject({ family: 'isobmff-moov', trak: 0 });
    expect(metadataOf(t)).toEqual(metadataOf((await headerTracks(blob, '')).get(t.trackId)!));
  });

  test('a file without a video track gets no capture and no warning', async () => {
    const r = await analyze(await fixture('audio_only_aac.mp4'), { codecConfig: true });
    expect(r.videoTracks).toEqual([]);
    expect(r.warnings).toEqual((await analyze(await fixture('audio_only_aac.mp4'))).warnings);
  });
});

describe('the probe engines with codecConfig on MP4 and MOV', () => {
  const engines: Record<string, (blob: Blob, codecConfig: boolean) => Promise<FileResult>> = {
    'the ISO BMFF worker': (blob, codecConfig) => singleContainerEngine('isobmff', analyzeIsoBmff).run(blob, 'a', { codecConfig }),
    'the worker engine': (blob, codecConfig) => engineAnalyze(blob, 'a', { codecConfig }),
    'a probe without Worker': (blob, codecConfig) => createProbe().analyze(blob, { codecConfig }),
  };

  test(`the ISO BMFF worker gives a view of the moov that color and aspect read as they read the boxes of analyzeHeader, on every fixture of the computed ISO BMFF set (${iso.length} files)`, async () => {
    const run = engines['the ISO BMFF worker'];
    let captured = 0;
    for (const name of iso) {
      const blob = await fixture(name);
      const plain = await run(blob, false);
      const r = await run(blob, true);
      expect(withoutConfig(r), name).toEqual(withoutConfig(plain));
      const fromHeader = await headerTracks(blob, name);
      const cloned = structuredClone(r);
      r.videoTracks.forEach((t, i) => {
        const at = `${name} track ${t.trackId}`;
        const c = t.codecConfig;
        if (c?.family !== 'isobmff-moov') throw new Error(`${at}: no view of the moov`);
        expect(c.moov, at).toBeInstanceOf(DataView);
        const moovOffset = r.layout?.moovOffset ?? NaN;
        const moovSize = r.layout?.moovSize ?? NaN;
        expect(c.moov.byteLength, at).toBe(moovOffset + moovSize > blob.size ? Math.min(blob.size - moovOffset, MOOV_SUSPECT_CAP) : moovSize);
        expect(String.fromCharCode(...new Uint8Array(c.moov.buffer, c.moov.byteOffset + 4, 4)), at).toBe('moov');
        expect(Number.isSafeInteger(c.trak), at).toBe(true);
        const header = fromHeader.get(t.trackId);
        if (header) {
          expect(metadataOf(t), at).toEqual(metadataOf(header));
          expect(metadataOf(cloned.videoTracks[i]), `${at} after a structured clone`).toEqual(metadataOf(header));
        }
        captured++;
      });
    }
    expect(captured).toBeGreaterThan(100);
  });

  test('a probe posts only the bytes of the moov, one copy for every video track, with the moov at the end or before the fragments', async () => {
    const files = [
      ['elst_trim_vfr_copy.mp4', 'moov-at-end', 1],
      ['multi_video_2tracks.mp4', 'moov-at-end', 2],
      ['fmp4_cmaf.mp4', 'fragmented', 1],
      ['fmp4_dash_single_file.mp4', 'fragmented', 1],
    ] as const;
    for (const [label, run] of Object.entries(engines)) {
      for (const [name, kind, videos] of files) {
        const blob = await fixture(name);
        const r = await run(blob, true);
        const at = `${label}, ${name}`;
        expect(r.layout?.kind, at).toBe(kind);
        expect(r.videoTracks.length, at).toBe(videos);
        expect(r.videoTracks.every((t) => t.codecConfig?.family === 'isobmff-moov'), at).toBe(true);
        expect(r.layout?.moovSize, at).toBeLessThan(blob.size / 10);
        expect(postedBytes(r), at).toBe(r.layout?.moovSize);
        expect(postedBytes(await run(blob, false)), at).toBe(0);
      }
    }
  });

  for (const [label, run] of Object.entries(engines)) {
    test(`${label} captures an MP4 or MOV video track with no warning`, async () => {
      for (const name of ['hdr10_hevc10.mp4', 'colr_nclc.mov', 'sar_h264_4x3.mp4']) {
        const blob = await fixture(name);
        const plain = await run(blob, false);
        const r = await run(blob, true);
        expect(r.warnings, name).toEqual(plain.warnings);
        expect(withoutConfig(r), name).toEqual(withoutConfig(plain));
        expect(r.videoTracks[0].codecConfig, name).toMatchObject({ family: 'isobmff-moov', trak: expect.any(Number) });
        expect(metadataOf(r.videoTracks[0]), name).toEqual(metadataOf((await headerTracks(blob, name)).get(r.videoTracks[0].trackId)!));
      }
      expect((await run(await fixture('audio_only_aac.mp4'), true)).warnings).toEqual([]);
    });
  }

  test('captures the TrackEntry of a Matroska or WebM video track with no warning', async () => {
    for (const name of ['h264.mkv', 'vp9.webm']) {
      const r = await createProbe().analyze(await fixture(name), { codecConfig: true });
      expect(r.videoTracks[0].codecConfig?.family, name).toBe('matroska');
      expect(warningCodesOf(r), name).toEqual([]);
    }
  });
});
