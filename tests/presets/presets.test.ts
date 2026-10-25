import { openAsBlob } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { check } from '../../src/check/index.ts';
import { analyze } from '../../src/core/analyze.ts';
import { emptyAnalysis, emptyTrack } from '../../src/core/result.ts';
import { makeRational } from '../../src/core/rational.ts';
import type { FileResult, VideoTrackResult } from '../../src/core/types.ts';
import * as presets from '../../src/presets/index.ts';
import type { ProviderPreset } from '../../src/presets/index.ts';
import { FILES_DIR } from '../helpers/fixtures.ts';

const STALE_AFTER_DAYS = 90;
const DAY_MS = 86_400_000;
const ALL = Object.entries(presets) as Array<[string, ProviderPreset]>;

const ageInDays = (preset: ProviderPreset, now: number): number => Math.floor((now - Date.parse(`${preset.verifiedAt}T00:00:00Z`)) / DAY_MS);
const stale = (now: number): Array<[string, ProviderPreset]> => ALL.filter(([, p]) => ageInDays(p, now) > STALE_AFTER_DAYS);

function result(track: Partial<VideoTrackResult>, file: Partial<FileResult> = {}): FileResult {
  const t: VideoTrackResult = { ...emptyTrack(1), codecName: 'h264', width: 1920, height: 1080, durationSec: 5, avgFps: makeRational(30, 1), isVfr: false, ...track };
  return { name: 'x.mp4', size: 10_000_000, ...emptyAnalysis('mp4'), videoTracks: [t], primaryTrackId: 1, audioTrackCount: 1, io: { reads: 1, bytesRead: 1, ms: 0 }, engine: 'own', ...file };
}

describe('presets', () => {
  it('exports the six provider presets as named exports', () => {
    expect(ALL.map(([name]) => name).sort()).toEqual(['klingMotionControl', 'klingO1ReferenceVideo', 'runwayAleph2', 'seedance2ReferenceVideo', 'veoExtend', 'wan26ReferenceToVideoFal']);
  });

  it.each(ALL)('%s has a name, an https source, a source kind, a verification date and a note', (_, preset) => {
    expect(preset.name.length).toBeGreaterThan(0);
    expect(new URL(preset.sourceUrl).protocol).toBe('https:');
    expect(['official', 'gateway']).toContain(preset.sourceKind);
    expect(preset.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Date(`${preset.verifiedAt}T00:00:00Z`).toISOString().slice(0, 10)).toBe(preset.verifiedAt);
    expect(Date.parse(`${preset.verifiedAt}T00:00:00Z`)).toBeLessThanOrEqual(Date.now());
    expect(preset.note.length).toBeGreaterThan(0);
  });

  it.each(ALL)('%s warns when its source is a gateway and fails otherwise', (_, preset) => {
    expect(preset.rules.severity ?? 'fail').toBe(preset.sourceKind === 'gateway' ? 'warn' : 'fail');
  });

  it.each(ALL)('%s has rules that check() accepts, unchanged through JSON', (_, preset) => {
    const r = result({});
    expect(() => check(r, preset.rules)).not.toThrow();
    expect(check(r, JSON.parse(JSON.stringify(preset.rules)) as ProviderPreset['rules'])).toEqual(check(r, preset.rules));
  });

  it.each(ALL.filter(([, p]) => p.rules.fileSize))('%s reads its size limit in MB as MiB and says so in its note', (_, preset) => {
    const max = preset.rules.fileSize!.max as number;
    expect(max % 1_048_576).toBe(0);
    expect(preset.note).toContain(`whether ${max / 1_048_576} MB is decimal or binary; the larger reading, ${max.toLocaleString('en-US')} bytes, is checked`);
  });

  it('warns, without failing, about a preset verified more than 90 days ago', () => {
    const verified = Date.parse('2026-10-25T00:00:00Z');
    expect(stale(verified + 90 * DAY_MS)).toEqual([]);
    expect(stale(verified + 91 * DAY_MS).length).toBe(ALL.length);
    for (const [name, preset] of stale(Date.now())) {
      const message = `${name} was verified on ${preset.verifiedAt}, ${ageInDays(preset, Date.now())} days ago: verify it again against ${preset.sourceUrl}`;
      if (process.env.GITHUB_ACTIONS) console.log(`::warning title=Stale preset::${message}`);
      else console.warn(`stale preset: ${message}`);
    }
  });
});

describe('presets: a file inside and a file outside each preset', () => {
  it.each([
    ['klingO1ReferenceVideo', {}, {}, { avgFps: makeRational(24000, 1001) }, {}, 'fail', ['fps.min']],
    ['klingMotionControl', { width: 1280, height: 720, durationSec: 20 }, {}, { durationSec: 31 }, {}, 'fail', ['duration.max']],
    ['runwayAleph2', { durationSec: 10 }, {}, { avgFps: makeRational(60, 1) }, {}, 'fail', ['fps.max']],
    ['veoExtend', { avgFps: makeRational(24, 1), durationSec: 8 }, {}, { avgFps: makeRational(24, 1), width: 1440 }, {}, 'fail', ['aspectRatio.oneOf']],
    ['wan26ReferenceToVideoFal', { avgFps: makeRational(16, 1) }, {}, {}, { size: 31_457_281 }, 'warn', ['fileSize.max']],
    ['seedance2ReferenceVideo', { width: 1280, height: 720, durationSec: 10 }, {}, { width: 3840, height: 2160 }, {}, 'warn', ['pixels.max']],
  ] as const)('%s', (name, inside, insideFile, outside, outsideFile, verdict, rules) => {
    const preset = presets[name];
    expect(check(result(inside, insideFile), preset.rules)).toEqual({ verdict: 'pass', violations: [] });
    const report = check(result(outside, outsideFile), preset.rules);
    expect(report.verdict).toBe(verdict);
    expect(report.violations.map((v) => v.rule)).toEqual(rules);
  });

  it('passes a file between 200 MB and 200 MiB under Kling O1 and fails a larger one', () => {
    expect(check(result({}, { size: 205_000_000 }), presets.klingO1ReferenceVideo.rules).verdict).toBe('pass');
    expect(check(result({}, { size: 209_715_200 }), presets.klingO1ReferenceVideo.rules).verdict).toBe('pass');
    expect(check(result({}, { size: 209_715_201 }), presets.klingO1ReferenceVideo.rules).violations.map((v) => v.rule)).toEqual(['fileSize.max']);
  });

  it('suggests 30 fps for a 60 fps file under Runway Aleph 2.0', () => {
    expect(check(result({ avgFps: makeRational(60, 1), durationSec: 10 }), presets.runwayAleph2.rules).suggestedFps).toEqual({ value: 30, reason: '60 fps is not allowed: convert to 30 fps, which keeps 1 of every 2 frames' });
  });

  it.each([
    ['91 frames of a 30 fps WebM (91000/3033) under Runway Aleph 2.0', 'runwayAleph2', { avgFps: makeRational(91000, 3033), codecName: 'vp9', durationSec: 3.033 }, 91, makeRational(30, 1), 'webm'],
    ['121 frames of a 30 fps MKV (121000/4033) under Runway Aleph 2.0', 'runwayAleph2', { avgFps: makeRational(121000, 4033), durationSec: 4.033 }, 121, makeRational(30, 1), 'matroska'],
    ['181 frames of a 60 fps MKV remuxed to MP4 (22625/377) under Kling O1', 'klingO1ReferenceVideo', { avgFps: makeRational(22625, 377), durationSec: 3.016 }, 181, makeRational(60, 1), 'mp4'],
  ] as const)('passes %s, judged by its nominal rate', (_, name, track, frames, nominal, container) => {
    const r = result({ ...track, frames, presentedFrames: frames, nominalFps: { ...nominal, kind: 'declared' }, timestampsQuantized: true }, { container });
    expect(check(r, presets[name].rules)).toEqual({ verdict: 'pass', violations: [] });
  });

  it('fails a committed 23.976 fps file under Kling O1 for its frame rate', async () => {
    const r = await analyze(await openAsBlob(join(FILES_DIR, 'cfr_h264_23.976.mp4')), 'cfr_h264_23.976.mp4');
    const report = check(r, presets.klingO1ReferenceVideo.rules);
    expect(report.verdict).toBe('fail');
    expect(report.violations.map((v) => v.rule)).toContain('fps.min');
    expect(report.suggestedFps?.value).toBe(24);
  });
});
