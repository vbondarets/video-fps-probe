import { openAsBlob, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { isoBmffFixtureSet } from '../../scripts/compare/layout.ts';
import { analyze } from '../../src/analyze.ts';
import { warningCodesOf } from '../../src/api/codes.ts';
import { analyze as engineAnalyze } from '../../src/core/analyze.ts';
import { analyzeIsoBmff } from '../../src/core/isobmff/index.ts';
import type { FileResult } from '../../src/core/types.ts';
import { analyzeHeader } from '../../src/header/index.ts';
import { createProbe } from '../../src/probe.ts';
import { singleContainerEngine } from '../../src/worker/single.ts';
import { FILES_DIR } from '../helpers/fixtures.ts';

const CAPTURE = '../../src/core/isobmff/config.ts';
const UNBOUNDED = { maxBytes: Infinity, maxReads: Infinity, maxMs: Infinity, maxTracks: Infinity, maxTopLevelBoxes: Infinity };
const fixture = (name: string) => openAsBlob(join(FILES_DIR, name));

function withoutConfig(r: FileResult) {
  const videoTracks = r.videoTracks.map((t) => {
    const copy = { ...t };
    delete copy.codecConfig;
    return copy;
  });
  return { ...r, io: null, videoTracks };
}

afterEach(() => {
  vi.doUnmock(CAPTURE);
  vi.resetModules();
});

const names = readdirSync(FILES_DIR).sort();
const iso = await isoBmffFixtureSet(names, (n) => join(FILES_DIR, n));

describe('analyze with codecConfig on MP4 and MOV', () => {
  test(`captures the boxes analyzeHeader captures, with one read of the moov, on every fixture of the computed ISO BMFF set (${iso.length} files)`, async () => {
    expect(iso.length).toBeGreaterThan(100);
    let captured = 0;
    for (const name of iso) {
      const blob = await fixture(name);
      const plain = await analyze(blob, { name });
      const r = await analyze(blob, { name, codecConfig: true });
      expect(withoutConfig(r), name).toEqual(withoutConfig(plain));
      expect(warningCodesOf(r), name).not.toContain('codec-config-unavailable');
      if (r.videoTracks.length > 0) {
        const { moovOffset, moovSize } = r.layout ?? {};
        expect(r.io.reads, name).toBe(plain.io.reads + 1);
        expect(r.io.bytesRead, name).toBe(plain.io.bytesRead + Math.min(moovSize ?? NaN, blob.size - (moovOffset ?? NaN)));
      } else expect(r.io, name).toMatchObject({ reads: plain.io.reads, bytesRead: plain.io.bytesRead });
      const header = await analyzeHeader(blob, { name, codecConfig: true, limits: UNBOUNDED });
      const fromHeader = new Map(header.videoTracks.map((t) => [t.trackId, t.codecConfig]));
      for (const t of r.videoTracks) {
        expect(t.codecConfig?.family, `${name} track ${t.trackId}`).toBe('isobmff');
        if (fromHeader.has(t.trackId)) expect(t.codecConfig, `${name} track ${t.trackId}`).toEqual(fromHeader.get(t.trackId));
        captured++;
      }
    }
    expect(captured).toBeGreaterThan(100);
  });

  test('a capture chunk that fails to load keeps the result and adds codec-config-unavailable', async () => {
    vi.resetModules();
    vi.doMock(CAPTURE, async () => {
      throw new TypeError('Failed to fetch dynamically imported module');
    });
    const failing = (await import('../../src/analyze.ts')).analyze;
    const blob = await fixture('hdr10_hevc10.mp4');
    const plain = await failing(blob);
    const r = await failing(blob, { codecConfig: true });
    expect(r.errorCode).toBeNull();
    expect(withoutConfig({ ...r, warnings: plain.warnings })).toEqual(withoutConfig(plain));
    expect(r.videoTracks[0]).not.toHaveProperty('codecConfig');
    expect(r.warnings).toEqual([...plain.warnings, expect.stringMatching(/^codec configuration unavailable: ./)]);
    expect(warningCodesOf(r)).toEqual(['codec-config-unavailable']);
  });

  test('a moov read that fails keeps the result and names the failure in codec-config-unavailable', async () => {
    const blob = await fixture('hdr10_hevc10.mp4');
    let reads = 0;
    const failing = { size: blob.size, slice: (start: number, end: number) => ({ arrayBuffer: () => (++reads > 1 ? Promise.reject(new Error('gone')) : blob.slice(start, end).arrayBuffer()) }) };
    const plain = await analyze(blob);
    const r = await analyze(failing, { codecConfig: true });
    expect(r.errorCode).toBeNull();
    expect(r.videoTracks[0]).not.toHaveProperty('codecConfig');
    expect(r.warnings).toEqual([...plain.warnings, 'codec configuration unavailable: gone']);
    expect(r.io).toMatchObject({ reads: plain.io.reads, bytesRead: plain.io.bytesRead });
  });

  test("an abort during the moov read rejects with the caller's reason", async () => {
    const blob = await fixture('hdr10_hevc10.mp4');
    const controller = new AbortController();
    const reason = new Error('stop');
    let reads = 0;
    const source = {
      size: blob.size,
      slice: (start: number, end: number) => ({
        arrayBuffer: () => {
          if (++reads > 1) controller.abort(reason);
          return blob.slice(start, end).arrayBuffer();
        },
      }),
    };
    await expect(analyze(source, { codecConfig: true, signal: controller.signal })).rejects.toBe(reason);
  });

  test('a file without a video track gets no capture and no warning', async () => {
    const r = await analyze(await fixture('audio_only_aac.mp4'), { codecConfig: true });
    expect(r.videoTracks).toEqual([]);
    expect(r.warnings).toEqual((await analyze(await fixture('audio_only_aac.mp4'))).warnings);
  });
});

describe('the probe engine with codecConfig', () => {
  const engines: Record<string, (blob: Blob, codecConfig: boolean) => Promise<FileResult>> = {
    'the worker engine': (blob, codecConfig) => engineAnalyze(blob, 'a', { codecConfig }),
    'the ISO BMFF worker': (blob, codecConfig) => singleContainerEngine('isobmff', analyzeIsoBmff).run(blob, 'a', { codecConfig }),
    'a probe without Worker': (blob, codecConfig) => createProbe().analyze(blob, { codecConfig }),
  };

  for (const [label, run] of Object.entries(engines)) {
    test(`${label} marks an MP4 or MOV video track it does not capture with codec-config-unavailable`, async () => {
      for (const name of ['hdr10_hevc10.mp4', 'colr_nclc.mov']) {
        const blob = await fixture(name);
        const plain = await run(blob, false);
        const r = await run(blob, true);
        expect(r.videoTracks[0], name).not.toHaveProperty('codecConfig');
        expect(r.warnings, name).toEqual([...plain.warnings, 'codec configuration unavailable']);
        expect(warningCodesOf(r), name).toEqual(['codec-config-unavailable']);
        expect({ ...r, io: null, warnings: null }, name).toEqual({ ...plain, io: null, warnings: null });
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
