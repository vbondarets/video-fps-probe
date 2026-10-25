import { openAsBlob } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { check, type CheckRules, type FpsRule } from '../../src/check/index.ts';
import { analyze } from '../../src/core/analyze.ts';
import { emptyAnalysis, emptyTrack } from '../../src/core/result.ts';
import { makeRational } from '../../src/core/rational.ts';
import type { FileResult, NominalFps, Rational, VideoTrackResult } from '../../src/core/types.ts';
import { FILES_DIR } from '../helpers/fixtures.ts';

const run = async (name: string) => analyze(await openAsBlob(join(FILES_DIR, name)), name);

const rate = (num: number, den = 1) => makeRational(num, den);

function result(track: Partial<VideoTrackResult> = {}, file: Partial<FileResult> = {}): FileResult {
  const t: VideoTrackResult = { ...emptyTrack(1), codecName: 'h264', width: 1920, height: 1080, durationSec: 5, avgFps: rate(30), isVfr: false, ...track };
  return { name: 'x.mp4', size: 1_000_000, ...emptyAnalysis('mp4'), videoTracks: [t], primaryTrackId: 1, audioTrackCount: 1, io: { reads: 1, bytesRead: 1, ms: 0 }, engine: 'own', ...file };
}

const rules = (r: CheckRules): CheckRules => r;
const failed = (r: FileResult | null, c: CheckRules) => check(r, c).violations.filter((v) => v.severity !== 'unknown').map((v) => v.rule);

describe('check: frame rate as exact rationals', () => {
  it.each([
    ['24000/1001 is below a minimum of 24', rate(24000, 1001), { min: 24 }, ['fps.min']],
    ['24 meets a minimum of 24', rate(24), { min: 24 }, []],
    ['24 meets a maximum of 24', rate(24), { max: 24 }, []],
    ['60000/1001 meets a maximum of 60', rate(60000, 1001), { max: 60 }, []],
    ['60000/1001 is below a minimum of 60', rate(60000, 1001), { min: 60 }, ['fps.min']],
    ['60 meets a range of 24 to 60', rate(60), { min: 24, max: 60 }, []],
    ['60001/1000 is above a maximum of 60', rate(60001, 1000), { max: 60 }, ['fps.max']],
    ['24000/1001 equals an exact 24000/1001', rate(24000, 1001), { exact: '24000/1001' }, []],
    ['24000/1001 equals an exact 24000:1001', rate(24000, 1001), { exact: '24000:1001' }, []],
    ['24000/1001 equals an exact 23.976, read as 24000/1001', rate(24000, 1001), { exact: 23.976 }, []],
    ['2997/125 equals an exact 23.976', rate(2997, 125), { exact: 23.976 }, []],
    ['30000/1001 meets a maximum of 29.97, read as 30000/1001', rate(30000, 1001), { max: 29.97 }, []],
    ['30000/1001 is not one of 24, 25 and 30', rate(30000, 1001), { oneOf: [24, 25, 30] }, ['fps.oneOf']],
    ['30000/1001 is one of 30000/1001 and 30', rate(30000, 1001), { oneOf: ['30000/1001', 30] }, []],
    ['25 is not an exact 24 and above a maximum of 24', rate(25), { exact: 24, max: 24 }, ['fps.max', 'fps.exact']],
  ] as const)('%s', (_, avgFps, fps, expected) => {
    expect(failed(result({ avgFps }), { fps })).toEqual(expected);
  });

  const ticked = (num: number, den: number, frames: number, nominal: Rational, kind: NominalFps['kind'] = 'declared'): Partial<VideoTrackResult> => ({ avgFps: rate(num, den), nominalFps: { ...nominal, kind }, timestampsQuantized: true, frames, presentedFrames: frames });

  it.each([
    ['180 frames of 60 fps on 1 ms ticks (180000/2999) meet a maximum of 60', ticked(180000, 2999, 180, rate(60)), { min: 24, max: 60 }, []],
    ['72 frames of 24 fps on 1 ms ticks (72000/2999) meet an exact 24 and a maximum of 24', ticked(72000, 2999, 72, rate(24)), { exact: 24, max: 24 }, []],
    ['91 frames of 30 fps on 1 ms ticks (91000/3033) meet a maximum of 30', ticked(91000, 3033, 91, rate(30)), { max: 30 }, []],
    ['181 frames of 60 fps remuxed to MP4 (22625/377) meet a maximum of 60', ticked(22625, 377, 181, rate(60), 'snapped'), { max: 60 }, []],
    ['72 frames of 23.976 fps on 1 ms ticks (36000/1501) stay below a minimum of 24', ticked(36000, 1501, 72, rate(24000, 1001)), { min: 24 }, ['fps.min']],
    ['a span 3 ms off the nominal one judges the nominal 60', ticked(180000, 3003, 180, rate(60)), { min: 60 }, []],
    ['a span 4 ms off the nominal one judges the average 180000/3004', ticked(180000, 3004, 180, rate(60)), { min: 60 }, ['fps.min']],
    ['a declared rate far from the average judges the average', ticked(50, 1, 150, rate(60)), { max: 50 }, []],
    ['a track not on 1 ms ticks judges its average', { ...ticked(180000, 2999, 180, rate(60), 'snapped'), timestampsQuantized: false }, { max: 60 }, ['fps.max']],
    ['a VFR track on 1 ms ticks judges its average', { ...ticked(180000, 2999, 180, rate(60)), isVfr: true }, { max: 60 }, ['fps.max']],
    ["source 'ffprobe' judges what ffprobe prints", { ...ticked(22625, 377, 181, rate(60), 'snapped'), avgFpsFfprobe: '22625/377' }, { max: 60, source: 'ffprobe' }, ['fps.max']],
  ] as const)('%s', (_, track, fps, expected) => {
    expect(failed(result(track), { fps })).toEqual(expected);
  });

  it.each([
    ['30000/1001 equals an exact 29.97', rate(30000, 1001), { exact: 29.97 }, []],
    ['2997/100 equals an exact 29.97 too', rate(2997, 100), { exact: 29.97 }, []],
    ['2997/100 meets a minimum of 29.97, the lower reading', rate(2997, 100), { min: 29.97 }, []],
    ['2996/100 is below a minimum of 29.97', rate(2996, 100), { min: 29.97 }, ['fps.min']],
    ['30 is above a maximum of 29.97', rate(30), { max: 29.97 }, ['fps.max']],
    ['30000/1001 is not an exact 30', rate(30000, 1001), { exact: 30 }, ['fps.exact']],
    ['60000/1001 meets a maximum of 59.94 given as a string', rate(60000, 1001), JSON.parse('{"max":"59.94"}') as FpsRule, []],
    ['60000/1001 equals an exact 59.940 with a trailing zero', rate(60000, 1001), JSON.parse('{"exact":"59.940"}') as FpsRule, []],
    ['48000/1001 equals an exact 47.952', rate(48000, 1001), { exact: 47.952 }, []],
    ['120000/1001 meets a maximum of 119.88', rate(120000, 1001), { max: 119.88 }, []],
    ['30000/1001 is one of 23.976, 29.97 and 59.94', rate(30000, 1001), { oneOf: [23.976, 29.97, 59.94] }, []],
    ['a fraction stays exact: 30000/1001 is above a maximum of 2997/100', rate(30000, 1001), { max: '2997/100' }, ['fps.max']],
    ['a decimal that is no NTSC rate stays exact: 30000/1001 is above a maximum of 29.9', rate(30000, 1001), { max: 29.9 }, ['fps.max']],
  ] as const)('reads a decimal NTSC rate as itself and as its x/1001 rate: %s', (_, avgFps, fps, expected) => {
    expect(failed(result({ avgFps }), { fps })).toEqual(expected);
  });

  it('prints the actual value with enough digits to differ from the bound it breaks', () => {
    const message = (r: FileResult, c: CheckRules) => check(r, c).violations[0]!.message;
    expect(message(result({ avgFps: rate(749251, 25000) }), { fps: { max: 29.97 } })).toBe('fps.max: 29.97004 (749251/25000) fps is above the maximum 29.97 fps');
    expect(message(result({ avgFps: rate(2996999, 100000) }), { fps: { min: 29.97 } })).toBe('fps.min: 29.96999 (2996999/100000) fps is below the minimum 29.97 fps');
    expect(message(result({ avgFps: rate(150001, 2500) }), { fps: { exact: 60 } })).toBe('fps.exact: 60.0004 (150001/2500) fps is not 60 fps');
    expect(message(result({ durationSec: 30.0004 }), { duration: { max: 30 } })).toBe('duration.max: 30.0004 s is above the maximum 30 s');
    expect(message(result({ avgFps: rate(24000, 1001) }), { fps: { min: 24 } })).toBe('fps.min: 23.976 (24000/1001) fps is below the minimum 24 fps');
  });

  describe('on a constant track on 1 ms ticks, within the resolution of its timestamps', () => {
    const webm5994 = { avgFps: rate(90000, 1501), nominalFps: { ...rate(19001, 317), kind: 'declared' as const }, timestampsQuantized: true, frames: 180, presentedFrames: 180, durationSec: 3.002 };
    it.each([
      ["an exact '60000/1001' matches the declared 19001/317", { exact: '60000/1001' }, []],
      ["a oneOf with '60000/1001' matches it", { oneOf: ['60000/1001', 30] }, []],
      ['an exact 59.94 matches it', { exact: 59.94 }, []],
      ['a maximum of 59.94 holds it', { max: 59.94 }, []],
      ["a maximum of '60000/1001' holds it", { max: '60000/1001' }, []],
      ['a minimum of 59.94 holds it', { min: 59.94 }, []],
      ['an exact 60 does not match it', { exact: 60 }, ['fps.exact']],
      ['a minimum of 60 does not hold it', { min: 60 }, ['fps.min']],
      ['a maximum of 59.9 does not hold it', { max: 59.9 }, ['fps.max']],
    ] as const)('%s', (_, fps, expected) => {
      expect(failed(result(webm5994), { fps })).toEqual(expected);
    });

    it('compares exactly off 1 ms ticks, on a VFR track and for a source other than the default', () => {
      expect(failed(result({ ...webm5994, timestampsQuantized: false }), { fps: { exact: '60000/1001' } })).toEqual(['fps.exact']);
      expect(failed(result({ ...webm5994, avgFpsFfprobe: '19001/317' }), { fps: { exact: '60000/1001', source: 'ffprobe' } })).toEqual(['fps.exact']);
      expect(failed(result({ ...webm5994, isVfr: true }), { fps: { exact: '60000/1001' } })).toEqual(['fps.exact']);
    });

    it('holds a track without a nominal rate to the 3 ms its span can be off', () => {
      const bare = { ...webm5994, nominalFps: null };
      expect(failed(result(bare), { fps: { exact: '60000/1001' } })).toEqual([]);
      expect(failed(result(bare), { fps: { oneOf: [24, 59.94] } })).toEqual([]);
      expect(failed(result(bare), { fps: { exact: 59.5 } })).toEqual(['fps.exact']);
      expect(failed(result({ ...bare, avgFps: rate(180000, 3006), durationSec: 3.006 }), { fps: { exact: '60000/1001' } })).toEqual([]);
      expect(failed(result({ ...bare, avgFps: rate(180000, 3007), durationSec: 3.007 }), { fps: { exact: '60000/1001' } })).toEqual(['fps.exact']);
    });
  });

  it('reports the rule, the expected value, the exact actual value and a message', () => {
    expect(check(result({ avgFps: rate(24000, 1001) }), { fps: { min: 24, max: 60 } })).toEqual({
      verdict: 'fail',
      violations: [{ rule: 'fps.min', severity: 'fail', expected: 24, actual: '24000/1001', message: 'fps.min: 23.976 (24000/1001) fps is below the minimum 24 fps' }],
      suggestedFps: { value: 24, reason: '23.976 (24000/1001) fps is not allowed: convert to 24 fps' },
    });
  });

  it('judges the ffprobe average, the nominal rate or the dominant rate when asked', () => {
    const vfr = result({ avgFps: rate(29), avgFpsFfprobe: '30000/1001', isVfr: true, dominantFps: { rate: rate(30), share: 0.9 }, minFps: rate(10), maxFps: rate(30) });
    expect(failed(vfr, { fps: { min: 30 } })).toEqual(['fps.min']);
    expect(failed(vfr, { fps: { min: 30, source: 'dominant' } })).toEqual([]);
    expect(failed(vfr, { fps: { max: 29.9, source: 'ffprobe' } })).toEqual(['fps.max']);
    expect(check(vfr, { fps: { min: 24, source: 'nominal' } }).violations).toEqual([{ rule: 'fps', severity: 'unknown', expected: null, actual: null, message: 'fps: unknown, no nominal frame rate' }]);
    const cfr = result({ avgFps: rate(25), nominalFps: { ...rate(25), kind: 'exact' } });
    expect(failed(cfr, { fps: { exact: 25, source: 'dominant' } })).toEqual([]);
    expect(check(result({ avgFpsFfprobe: '0/0' }), { fps: { min: 24, source: 'ffprobe' } }).verdict).toBe('unknown');
  });

  it('throws a TypeError for a value that is not a non-negative number or num/den', () => {
    for (const fps of [{ min: 'fast' }, { max: -1 }, { exact: Number.NaN }, { oneOf: ['24/0'] }, { min: '24/' }]) {
      expect(() => check(result(), { fps } as CheckRules), JSON.stringify(fps)).toThrow(TypeError);
    }
    expect(() => check(null, { fps: { min: 'fast' } } as unknown as CheckRules)).toThrow('fps.min: "fast" is not a non-negative number');
  });
});

describe('check: rule validation', () => {
  const thrown = (f: () => unknown): unknown => {
    try {
      f();
    } catch (e) {
      return e;
    }
    return null;
  };

  it.each([
    ['a negative frame size', '{"frameSize":{"minWidth":-5}}', "frameSize.minWidth: -5 is not a non-negative number or 'num/den'"],
    ['a frame size that is not a number', '{"frameSize":{"minShortSide":"wide"}}', 'frameSize.minShortSide: "wide" is not a non-negative number or \'num/den\''],
    ['an allowlist entry that is not a string', '{"containers":["mp4",4]}', 'containers: ["mp4",4] is not a list of strings'],
    ['an allowlist that is not a list', '{"codecs":"h264"}', 'codecs: "h264" is not a list of strings'],
    ['an audio rule it does not know', '{"audio":"require"}', 'audio: "require" is not one of required, forbidden'],
    ['a vfr policy it does not know', '{"vfr":"rejected"}', 'vfr: "rejected" is not one of allow, warn, reject'],
    ['an uneven policy it does not know', '{"uneven":true}', 'uneven: true is not one of allow, warn, reject'],
    ['a severity it does not know', '{"severity":"warning"}', 'severity: "warning" is not one of fail, warn'],
    ['a frame rate source it does not know', '{"fps":{"min":24,"source":"mean"}}', 'fps.source: "mean" is not one of avg, ffprobe, nominal, dominant'],
    ['a rule group that is not an object', '{"fps":24}', 'fps: 24 is not an object'],
    ['rules that are not an object', 'null', 'rules: null is not an object'],
    ['rules that are a list', '[{"fps":{"min":24}}]', 'rules: [{"fps":{"min":24}}] is not an object'],
    ['a rule group that is a list', '{"fps":[24,60]}', 'fps: [24,60] is not an object'],
    ['a typo in a bound', '{"fps":{"min":24,"mxa":60}}', 'fps.mxa: not a rule; expected one of min, max, exact, oneOf, source'],
    ['a frame size key it does not know', '{"frameSize":{"maxwidth":1080}}', 'frameSize.maxwidth: not a rule; expected one of minWidth, maxWidth, minHeight, maxHeight, minShortSide, maxShortSide, minLongSide, maxLongSide'],
    ['an exact bound in a range group', '{"duration":{"exact":3}}', 'duration.exact: not a rule; expected one of min, max'],
    ['a oneOf in a range group', '{"pixels":{"oneOf":[921600]}}', 'pixels.oneOf: not a rule; expected one of min, max'],
    ['a typo in a rule name', '{"fsp":{"max":60}}', 'fsp: not a rule; expected one of fps, duration, frameSize, aspectRatio, pixels, fileSize, containers, codecs, audio, vfr, uneven, severity'],
    ['a bound given as a list', '{"fps":{"min":[24]}}', 'fps.min: [24] is not a non-negative number or \'num/den\''],
    ['an exact rate given as a list', '{"fps":{"exact":[24,25]}}', 'fps.exact: [24,25] is not a non-negative number or \'num/den\''],
    ['a bound of the wrong type', '{"duration":{"max":true}}', 'duration.max: true is not a non-negative number or \'num/den\''],
    ['a oneOf entry of the wrong type', '{"aspectRatio":{"oneOf":["16/9",{}]}}', 'aspectRatio.oneOf: {} is not a non-negative number or \'num/den\''],
  ])('throws a TypeError naming the rule for %s, whatever the result', (_, json, message) => {
    for (const r of [result(), result({}, { error: 'moov box not found' }), null]) {
      expect(thrown(() => check(r, JSON.parse(json) as CheckRules)), json).toEqual(new TypeError(message));
    }
    expect(thrown(() => check(result(), undefined as unknown as CheckRules))).toEqual(new TypeError('rules: undefined is not an object'));
  });

  it('judges a frame size given as a decimal string, as every other bound', () => {
    expect(failed(result(), JSON.parse('{"frameSize":{"minShortSide":"2000","maxLongSide":"1920"}}') as CheckRules)).toEqual(['frameSize.minShortSide']);
  });

  it('gives one unknown entry for the frame size rule of a track without a size', () => {
    expect(check(result({ width: 0, height: 0 }), { frameSize: { minWidth: 1, maxHeight: 2, minShortSide: 1 } }).violations).toEqual([{ rule: 'frameSize', severity: 'unknown', expected: null, actual: null, message: 'frameSize: unknown, no frame size' }]);
  });
});

describe('check: bounds of the frame size', () => {
  it('reports the side, the bound and the size', () => {
    expect(check(result({ width: 699, height: 1000 }), { frameSize: { minShortSide: 700 } }).violations).toEqual([{ rule: 'frameSize.minShortSide', severity: 'fail', expected: 700, actual: 699, message: 'frameSize.minShortSide: 699 px is below the minimum 700 px' }]);
  });
});

describe('check: duration, frame size, aspect ratio, pixels and file size', () => {
  it.each([
    ['3 s meets a minimum of 3', { durationSec: 3 }, { duration: { min: 3 } }, []],
    ['2.999 s is below a minimum of 3', { durationSec: 2.999 }, { duration: { min: 3 } }, ['duration.min']],
    ['10 s meets a maximum of 10', { durationSec: 10 }, { duration: { max: 10 } }, []],
    ['10.001 s is above a maximum of 10', { durationSec: 10.001 }, { duration: { max: 10 } }, ['duration.max']],
    ['1920x1080 rotated by 90 is 1080 wide', { rotation: 90 }, { frameSize: { maxWidth: 1080, minHeight: 1920 } }, []],
    ['1920x1080 rotated by 90 is above a maximum height of 1080', { rotation: 90 }, { frameSize: { maxHeight: 1080 } }, ['frameSize.maxHeight']],
    ['1920x1080 rotated by -90 swaps too', { rotation: -90 }, { frameSize: { maxWidth: 1080 } }, []],
    ['1920x1080 rotated by 270 swaps too', { rotation: 270 }, { frameSize: { maxWidth: 1080 } }, []],
    ['1920x1080 rotated by 180 does not swap', { rotation: 180 }, { frameSize: { maxWidth: 1080 } }, ['frameSize.maxWidth']],
    ['699x1000 is below a short side of 700', { width: 699, height: 1000 }, { frameSize: { minShortSide: 700, maxLongSide: 2160 } }, ['frameSize.minShortSide']],
    ['700x2160 meets a short side of 700 and a long side of 2160', { width: 700, height: 2160 }, { frameSize: { minShortSide: 700, maxLongSide: 2160 } }, []],
    ['2161x1000 is above a long side of 2160', { width: 2161, height: 1000 }, { frameSize: { minWidth: 700, maxWidth: 2161, maxLongSide: 2160 } }, ['frameSize.maxLongSide']],
    ['16/9 meets a maximum of 16:9', {}, { aspectRatio: { max: '16:9' } }, []],
    ['16/9 is above a maximum of 1.7777', {}, { aspectRatio: { max: 1.7777 } }, ['aspectRatio.max']],
    ['1080x1920 is one of 16/9 and 9/16', { rotation: 90 }, { aspectRatio: { oneOf: ['16/9', '9/16'] } }, []],
    ['1440x1080 is not one of 16/9 and 9/16', { width: 1440 }, { aspectRatio: { oneOf: ['16/9', '9/16'] } }, ['aspectRatio.oneOf']],
    ['400x1000 meets a minimum aspect ratio of 0.4', { width: 400, height: 1000 }, { aspectRatio: { min: 0.4, max: 2.5 } }, []],
    ['399x1000 is below a minimum aspect ratio of 0.4', { width: 399, height: 1000 }, { aspectRatio: { min: 0.4, max: 2.5 } }, ['aspectRatio.min']],
    ['640x640 meets a minimum of 409600 pixels', { width: 640, height: 640 }, { pixels: { min: 409_600 } }, []],
    ['639x640 is below a minimum of 409600 pixels', { width: 639, height: 640 }, { pixels: { min: 409_600 } }, ['pixels.min']],
  ] as const)('%s', (_, track, r, expected) => {
    expect(failed(result(track), r as CheckRules)).toEqual(expected);
  });

  it.each([
    ['180 frames of 60 fps on 1 ms ticks spanning 2.999 s meet a minimum of 3 s', { avgFps: rate(180000, 2999), durationSec: 2.999, nominal: rate(60), frames: 180 }, { min: 3 }, []],
    ['900 frames of 30 fps on 1 ms ticks spanning 30.001 s meet a maximum of 30 s', { avgFps: rate(900000, 30001), durationSec: 30.001, nominal: rate(30), frames: 900 }, { max: 30 }, []],
    ['901 frames of 30 fps on 1 ms ticks are above a maximum of 30 s', { avgFps: rate(901000, 30033), durationSec: 30.033, nominal: rate(30), frames: 901 }, { max: 30 }, ['duration.max']],
    ['a declared rate far from the average leaves the measured 2.999 s', { avgFps: rate(50), durationSec: 2.999, nominal: rate(60), frames: 150 }, { min: 3 }, ['duration.min']],
  ] as const)('%s', (_, { nominal, frames, ...track }, duration, expected) => {
    expect(failed(result({ ...track, nominalFps: { ...nominal, kind: 'declared' }, timestampsQuantized: true, frames, presentedFrames: frames }), { duration })).toEqual(expected);
  });

  it('reports the duration of a constant track on 1 ms ticks as its frames over its nominal rate', () => {
    const track = { avgFps: rate(901000, 30033), durationSec: 30.033, nominalFps: { ...rate(30), kind: 'declared' as const }, timestampsQuantized: true, frames: 901, presentedFrames: 901 };
    expect(check(result(track), { duration: { max: 30 } }).violations).toEqual([{ rule: 'duration.max', severity: 'fail', expected: 30, actual: 901 / 30, message: 'duration.max: 30.033 s is above the maximum 30 s' }]);
  });

  it('treats a size that is not a whole number as missing, instead of throwing', () => {
    const sizes: CheckRules = { frameSize: { minWidth: 1 }, aspectRatio: { max: 2 }, pixels: { max: 1e7 } };
    for (const track of [{ width: 853.33 }, { height: Number.NaN }, { width: Number.POSITIVE_INFINITY }, { width: -1920 }]) {
      expect(check(result(track), sizes).violations.map((v) => [v.rule, v.severity]), JSON.stringify(track)).toEqual([
        ['frameSize', 'unknown'],
        ['aspectRatio', 'unknown'],
        ['pixels', 'unknown'],
      ]);
    }
  });

  it('uses the format duration when the track has none', () => {
    expect(failed(result({ durationSec: null }, { formatDurationSec: 31 }), { duration: { max: 30 } })).toEqual(['duration.max']);
  });

  it('includes the file size bounds', () => {
    expect(failed(result({}, { size: 200_000_000 }), { fileSize: { max: 200_000_000 } })).toEqual([]);
    expect(failed(result({}, { size: 200_000_001 }), { fileSize: { max: 200_000_000 } })).toEqual(['fileSize.max']);
  });
});

describe('check: allowlists, audio and rate policies', () => {
  it('compares the container and the codec with their allowlists', () => {
    expect(failed(result({}, { container: 'webm' }), { containers: ['mp4', 'mov'] })).toEqual(['containers']);
    expect(failed(result({}, { container: 'mov' }), { containers: ['mp4', 'mov'] })).toEqual([]);
    expect(failed(result({ codecName: 'vp9' }), { codecs: ['h264', 'hevc'] })).toEqual(['codecs']);
    expect(failed(result(), { codecs: ['H264'] })).toEqual([]);
    expect(failed(result({ codecName: 'HEVC' }), { codecs: ['hevc'] })).toEqual([]);
    expect(check(result({ codecName: 'unknown' }), { codecs: ['h264'] }).verdict).toBe('unknown');
    expect(check(result({}, { container: 'unknown' }), { containers: ['mp4'] }).violations[0]).toMatchObject({ rule: 'containers', severity: 'unknown', message: 'containers: unknown, no container' });
  });

  it('requires or forbids audio', () => {
    expect(failed(result({}, { audioTrackCount: 0 }), { audio: 'required' })).toEqual(['audio']);
    expect(failed(result({}, { audioTrackCount: 2 }), { audio: 'required' })).toEqual([]);
    expect(failed(result({}, { audioTrackCount: 1 }), { audio: 'forbidden' })).toEqual(['audio']);
    expect(failed(result({}, { audioTrackCount: 0 }), { audio: 'forbidden' })).toEqual([]);
  });

  it('fails open on audio for an engine that does not report audio, such as rvfc', () => {
    const rvfc = (): FileResult => ({ ...result({ avgFps: rate(30) }), ...emptyAnalysis('unknown'), videoTracks: [{ ...emptyTrack(1), width: 1280, height: 720, avgFps: rate(30) }], primaryTrackId: 1, engine: 'rvfc' });
    expect(rvfc().audioTrackCount).toBe(0);
    for (const audio of ['required', 'forbidden'] as const) {
      expect(check(rvfc(), { audio }).violations).toEqual([{ rule: 'audio', severity: 'unknown', expected: null, actual: null, message: 'audio: unknown, no audio track count (the rvfc engine reports none)' }]);
    }
    expect(check(rvfc(), { audio: 'required', fps: { max: 60 } }).verdict).toBe('unknown');
    for (const engine of ['own', 'mp4box', 'mediabunny'] as const) {
      expect(failed(result({}, { audioTrackCount: 0, engine }), { audio: 'required' }), engine).toEqual(['audio']);
      expect(failed(result({}, { audioTrackCount: 1, engine }), { audio: 'forbidden' }), engine).toEqual(['audio']);
    }
    expect(check(JSON.parse(JSON.stringify({ ...result(), audioTrackCount: undefined })) as FileResult, { audio: 'required' }).verdict).toBe('unknown');
  });

  it('allows, warns about or rejects VFR', () => {
    const vfr = result({ isVfr: true });
    expect(check(vfr, { vfr: 'allow' })).toEqual({ verdict: 'pass', violations: [] });
    expect(check(vfr, { vfr: 'warn' }).verdict).toBe('warn');
    expect(check(vfr, { vfr: 'reject' }).violations).toEqual([{ rule: 'vfr', severity: 'fail', expected: 'reject', actual: true, message: 'vfr: the frame rate is variable' }]);
    expect(check(result({ isVfr: false }), { vfr: 'reject' }).verdict).toBe('pass');
    expect(check(result({ isVfr: null }), { vfr: 'reject' }).verdict).toBe('unknown');
  });

  it('judges an uneven rate from the rate profile, and from the interval spread without one', () => {
    const profile = { segments: [], moreSegments: 0, anomalies: [], moreAnomalies: 0, buckets: { bucketSec: 1, fps: [] }, uneven: true, dominantShare: 0.5, summary: 'Uneven: 5 fps for 4 s, 200 fps for 4 s' };
    expect(check(result({ isVfr: true, rateProfile: profile }), { uneven: 'reject' }).violations[0]).toMatchObject({ rule: 'uneven', severity: 'fail', message: 'uneven: the frame rate is uneven: Uneven: 5 fps for 4 s, 200 fps for 4 s' });
    expect(check(result({ isVfr: true, rateProfile: { ...profile, uneven: false } }), { uneven: 'reject' }).verdict).toBe('pass');
    expect(check(result({ isVfr: false }), { uneven: 'reject' }).verdict).toBe('pass');
    expect(check(result({ isVfr: true, minFps: rate(29), maxFps: rate(31) }), { uneven: 'reject' }).verdict).toBe('pass');
    expect(check(result({ isVfr: true, minFps: rate(20), maxFps: rate(30) }), { uneven: 'reject' }).verdict).toBe('unknown');
    expect(check(result({ isVfr: true, rateProfile: profile }), { uneven: 'warn' }).verdict).toBe('warn');
  });
});

describe('check: verdict, severity and failing open', () => {
  it('ranks fail over unknown over warn over pass', () => {
    const r = result({ isVfr: true, codecName: '' });
    expect(check(r, {}).verdict).toBe('pass');
    expect(check(r, { vfr: 'warn' }).verdict).toBe('warn');
    expect(check(r, { vfr: 'warn', codecs: ['h264'] }).verdict).toBe('unknown');
    expect(check(r, { vfr: 'warn', codecs: ['h264'], duration: { max: 1 } }).verdict).toBe('fail');
  });

  it("reports every violation as a warning when the rules' severity is warn", () => {
    const report = check(result({ avgFps: rate(24000, 1001) }), { fps: { min: 24 }, duration: { max: 1 }, vfr: 'reject', severity: 'warn' });
    expect(report.verdict).toBe('warn');
    expect(report.violations.map((v) => [v.rule, v.severity])).toEqual([
      ['fps.min', 'warn'],
      ['duration.max', 'warn'],
    ]);
  });

  it('is unknown for a missing result, judging nothing', () => {
    const report = check(null, { fps: { min: 24 }, fileSize: { max: 1 }, containers: ['mp4'], audio: 'required', vfr: 'reject' });
    expect(report.verdict).toBe('unknown');
    expect(report.violations.map((v) => [v.rule, v.severity])).toEqual([
      ['fps', 'unknown'],
      ['fileSize', 'unknown'],
      ['containers', 'unknown'],
      ['audio', 'unknown'],
      ['vfr', 'unknown'],
    ]);
    expect(report.violations[0]!.message).toBe('fps: unknown, the analysis failed: no result');
  });

  it('judges only the file size and the container of a result with an error', () => {
    const broken = result({}, { error: 'moov box not found', size: 300_000_000 });
    const all: CheckRules = { fps: { min: 24 }, duration: { max: 30 }, frameSize: { maxLongSide: 2160 }, pixels: { max: 1 }, codecs: ['h264'], audio: 'required', vfr: 'reject', uneven: 'reject' };
    expect(check(broken, all).verdict).toBe('unknown');
    expect(check(broken, all).violations.every((v) => v.severity === 'unknown' && v.message.endsWith('the analysis failed: moov box not found'))).toBe(true);
    expect(failed(broken, { ...all, fileSize: { max: 200_000_000 }, containers: ['mov'] })).toEqual(['fileSize.max', 'containers']);
    expect(check(broken, { ...all, fileSize: { max: 200_000_000 } }).verdict).toBe('fail');
  });

  it('ignores a rule group without a bound and a null bound, and throws for a key it does not know', () => {
    const blank = result({ avgFps: null, width: 0, height: 0 });
    expect(check(blank, { fps: { source: 'ffprobe' }, duration: {}, frameSize: {}, aspectRatio: {} })).toEqual({ verdict: 'pass', violations: [] });
    expect(check(result({ avgFps: rate(24000, 1001) }), JSON.parse('{"fps":{"min":24,"max":null},"frameSize":{"maxWidth":null},"audio":null}') as CheckRules).violations.map((v) => v.rule)).toEqual(['fps.min']);
    expect(() => check(result(), { frameSize: { fooWidth: 1 } } as unknown as CheckRules)).toThrow(new TypeError('frameSize.fooWidth: not a rule; expected one of minWidth, maxWidth, minHeight, maxHeight, minShortSide, maxShortSide, minLongSide, maxLongSide'));
  });

  it('is unknown without a video track', () => {
    expect(check(result({}, { videoTracks: [], primaryTrackId: null }), { fps: { min: 24 } }).violations[0]!.message).toBe('fps: unknown, no video track');
  });

  it('is unknown, without throwing, for a partial or older result without videoTracks', () => {
    const rulesAll: CheckRules = { fps: { min: 24 }, duration: { max: 30 }, pixels: { max: 1 }, codecs: ['h264'], fileSize: { max: 100 }, vfr: 'reject' };
    for (const json of ['{"name":"x.mp4","size":50}', '{"name":"x.mp4","size":50,"videoTracks":null,"primaryTrackId":1}', '{"size":50,"error":null,"container":"mp4"}']) {
      const partial = JSON.parse(json) as FileResult;
      expect(() => check(partial, rulesAll), json).not.toThrow();
      const report = check(partial, rulesAll);
      expect(report.verdict, json).toBe('unknown');
      expect(report.violations.map((v) => [v.rule, v.severity]), json).toEqual([
        ['fps', 'unknown'],
        ['duration', 'unknown'],
        ['pixels', 'unknown'],
        ['codecs', 'unknown'],
        ['vfr', 'unknown'],
      ]);
      expect(report.violations[0]!.message).toBe('fps: unknown, no video track');
    }
    expect(check(JSON.parse('{"size":500}') as FileResult, { fileSize: { max: 100 } }).verdict).toBe('fail');
  });
});

describe('check: suggestedFps', () => {
  it.each([
    ['raises 24000/1001 to a minimum of 24', rate(24000, 1001), { min: 24, max: 60 }, 24, '23.976 (24000/1001) fps is not allowed: convert to 24 fps'],
    ['halves 120 to a maximum of 60', rate(120), { min: 24, max: 60 }, 60, '120 fps is not allowed: convert to 60 fps, which keeps 1 of every 2 frames'],
    ['halves 50 under a maximum of 30', rate(50), { min: 24, max: 30 }, 25, '50 fps is not allowed: convert to 25 fps, which keeps 1 of every 2 frames'],
    ['halves 60000/1001 under a maximum of 30', rate(60000, 1001), { max: 30 }, 30000 / 1001, '59.94 (60000/1001) fps is not allowed: convert to 29.97 fps, which keeps 1 of every 2 frames'],
    ['retimes 60.06 to a maximum of 60', rate(6006, 100), { max: 60 }, 60, '60.06 (3003/50) fps is not allowed: convert to 60 fps'],
    ['retimes 40 to a maximum of 30', rate(40), { max: 30 }, 30, '40 fps is not allowed: convert to 30 fps'],
    ['takes an exact rate', rate(30), { exact: 24 }, 24, '30 fps is not allowed: convert to 24 fps'],
    ['takes the nearest allowed rate', rate(26), { oneOf: [24, 30] }, 24, '26 fps is not allowed: convert to 24 fps'],
    ['takes the lower of two equally near rates', rate(27), { oneOf: [24, 30] }, 24, '27 fps is not allowed: convert to 24 fps'],
  ] as const)('%s', (_, avgFps, fps, value, reason) => {
    expect(check(result({ avgFps }), { fps }).suggestedFps).toEqual({ value, reason });
  });

  it('takes a oneOf rate given without a list from JSON, as the bound does', () => {
    expect(check(result({ avgFps: rate(30) }), JSON.parse('{"fps":{"oneOf":24}}') as CheckRules)).toEqual({
      verdict: 'fail',
      violations: [{ rule: 'fps.oneOf', severity: 'fail', expected: 24, actual: '30/1', message: 'fps.oneOf: 30 fps is not one of 24 fps' }],
      suggestedFps: { value: 24, reason: '30 fps is not allowed: convert to 24 fps' },
    });
  });

  it('suggests a constant rate for rejected VFR, within the frame rate rule', () => {
    const vfr = result({ avgFps: rate(2987, 100), isVfr: true, dominantFps: { rate: rate(30), share: 0.7 } });
    expect(check(vfr, { vfr: 'reject' }).suggestedFps).toEqual({ value: 30, reason: 'the frame rate is variable: re-encode at a constant 30 fps' });
    expect(check(result({ avgFps: rate(2987, 100), isVfr: true }), { vfr: 'warn' }).suggestedFps).toEqual({ value: 30, reason: 'the frame rate is variable: re-encode at a constant 30 fps' });
    expect(check(result({ avgFps: rate(23, 1), isVfr: true, dominantFps: { rate: rate(24000, 1001), share: 0.8 } }), { fps: { min: 24 }, vfr: 'reject' }).suggestedFps).toEqual({ value: 24, reason: '23 fps is not allowed: convert to 24 fps' });
  });

  it('suggests nothing when the rate passes or is unknown', () => {
    expect(check(result(), { fps: { min: 24 }, vfr: 'reject' }).suggestedFps).toBeUndefined();
    expect(check(result({ avgFps: null }), { fps: { min: 24 } }).suggestedFps).toBeUndefined();
    expect(check(result({ durationSec: 99 }), { duration: { max: 30 } }).suggestedFps).toBeUndefined();
  });
});

describe('check: JSON', () => {
  const all: CheckRules = rules({
    fps: { min: '24000/1001', max: 60, oneOf: [24, '30000/1001', 30, 60], source: 'avg' },
    duration: { min: 2, max: 30 },
    frameSize: { minWidth: 300, maxWidth: 6000, minHeight: 300, maxHeight: 6000, minShortSide: 480, maxLongSide: 3000 },
    aspectRatio: { min: 0.4, max: '2.5:1' },
    pixels: { min: 409_600, max: 2_086_876 },
    fileSize: { max: 50_000_000 },
    containers: ['mp4', 'mov'],
    codecs: ['h264', 'hevc'],
    audio: 'forbidden',
    vfr: 'warn',
    uneven: 'reject',
    severity: 'fail',
  });

  it('gives the same report for rules that went through JSON, and the report survives JSON', () => {
    const inputs = [result(), result({ avgFps: rate(25), isVfr: true, width: 3840, height: 2160, codecName: 'av1' }, { container: 'webm', size: 60_000_000 }), result({}, { error: 'x' }), null];
    for (const r of inputs) {
      const report = check(r, all);
      expect(check(r, JSON.parse(JSON.stringify(all)) as CheckRules)).toEqual(report);
      expect(JSON.parse(JSON.stringify(report))).toEqual(report);
    }
    expect(check(inputs[1]!, all).violations.map((v) => v.rule)).toEqual(['fps.oneOf', 'frameSize.maxLongSide', 'pixels.max', 'fileSize.max', 'containers', 'codecs', 'audio', 'vfr', 'uneven']);
  });
});

describe('check: committed fixtures', () => {
  it('judges 23.976 and 59.94 against whole-number bounds exactly', async () => {
    const fps = { min: 24, max: 60 };
    expect(check(await run('cfr_h264_23.976.mp4'), { fps }).verdict).toBe('fail');
    expect(check(await run('cfr_h264_24.mp4'), { fps }).verdict).toBe('pass');
    expect(check(await run('cfr_h264_59.94.mp4'), { fps }).verdict).toBe('pass');
    expect(check(await run('cfr_h264_60.mp4'), { fps }).verdict).toBe('pass');
    expect(check(await run('cfr_h264_59.94.mp4'), { fps: { min: 60 } }).verdict).toBe('fail');
    expect(check(await run('cfr_vp9_23.976.webm'), { fps, containers: ['webm'] }).violations.map((v) => v.rule)).toEqual(['fps.min']);
  });

  it.each([
    ['cfr_vp9_59.94.webm', { exact: '60000/1001' }, 'pass'],
    ['cfr_vp9_59.94.webm', { oneOf: ['60000/1001'] }, 'pass'],
    ['cfr_vp9_59.94.webm', { exact: 59.94 }, 'pass'],
    ['cfr_vp9_59.94.webm', { max: 59.94 }, 'pass'],
    ['cfr_vp9_59.94.webm', { min: 59.94, max: '60000/1001' }, 'pass'],
    ['cfr_vp9_59.94.webm', { exact: 60 }, 'fail'],
    ['cfr_vp9_59.94.webm', { min: 60 }, 'fail'],
    ['cfr_vp9_59.94.webm', { max: 60 }, 'pass'],
    ['cfr_h264_59.94.mp4', { exact: '60000/1001' }, 'pass'],
    ['cfr_h264_59.94.mp4', { max: 59.94 }, 'pass'],
    ['cfr_h264_29.97.mp4', { max: 29.97 }, 'pass'],
    ['cfr_h264_29.97.mp4', { exact: 29.97 }, 'pass'],
    ['cfr_h264_29.97.mp4', { exact: '30000/1001' }, 'pass'],
    ['cfr_h264_29.97.mp4', { oneOf: [24, 29.97] }, 'pass'],
    ['cfr_h264_29.97.mp4', { min: 30 }, 'fail'],
    ['cfr_h264_29.97.mp4', { exact: 30 }, 'fail'],
    ['cfr_h264_29.97.mp4', { max: '2997/100' }, 'fail'],
    ['cfr_vp9_29.97.webm', { exact: '30000/1001', max: 29.97 }, 'pass'],
    ['cfr_h264_23.976.mp4', { exact: 23.976 }, 'pass'],
    ['cfr_h264_23.976.mp4', { max: 23.976 }, 'pass'],
    ['cfr_h264_23.976.mp4', { exact: '24000/1001' }, 'pass'],
    ['cfr_h264_23.976.mp4', { min: 24 }, 'fail'],
    ['cfr_h264_23.976.mp4', { exact: 24 }, 'fail'],
    ['cfr_vp9_23.976.webm', { exact: 23.976, max: 23.976 }, 'pass'],
    ['cfr_vp9_23.976.webm', { min: 24 }, 'fail'],
  ] as const)('judges NTSC rates of %s: %j is %s', async (name, fps, verdict) => {
    expect(check(await run(name), { fps }).verdict).toBe(verdict);
  });

  it('judges a constant WebM on 1 ms ticks by its nominal rate at whole-number bounds', async () => {
    const [w24, w5994, w60] = await Promise.all(['cfr_vp9_24.webm', 'cfr_vp9_59.94.webm', 'cfr_vp9_60.webm'].map(run));
    expect([w24, w60].map((r) => r.videoTracks[0]!.avgFps)).toMatchObject([{ num: 72000, den: 2999 }, { num: 180000, den: 2999 }]);
    expect(check(w60, { fps: { min: 24, max: 60 } })).toEqual({ verdict: 'pass', violations: [] });
    expect(check(w60, { fps: { exact: 60 } }).verdict).toBe('pass');
    expect(check(w24, { fps: { max: 24 } }).verdict).toBe('pass');
    expect(check(w24, { fps: { exact: 24 } }).verdict).toBe('pass');
    expect(check(w5994, { fps: { max: 60 } }).verdict).toBe('pass');
    expect(check(w5994, { fps: { min: 60 } }).violations.map((v) => [v.rule, v.actual])).toEqual([['fps.min', '19001/317']]);
  });

  it('judges the 3 s of a constant 60 fps WebM whose 1 ms ticks span 2.999 s', async () => {
    const w60 = await run('cfr_vp9_60.webm');
    expect(w60.videoTracks[0]!.durationSec).toBe(2.999);
    expect(check(w60, { duration: { min: 3, max: 3 } })).toEqual({ verdict: 'pass', violations: [] });
  });

  it('rejects the uneven two-phase recording and suggests a rate', async () => {
    const report = check(await run('vfr_two_phase_5_200.mp4'), { fps: { min: 24, max: 60 }, vfr: 'reject', uneven: 'reject' });
    expect(report.verdict).toBe('fail');
    expect(report.violations.map((v) => v.rule)).toEqual(expect.arrayContaining(['vfr', 'uneven']));
    expect(report.suggestedFps?.value).toBeGreaterThanOrEqual(24);
  });

  it('is unknown for a file that is not a video', async () => {
    expect(check(await run('corrupt_png_named.mp4'), { fps: { min: 24 }, containers: ['mp4'] }).verdict).toBe('unknown');
    expect(check(await run('audio_only_aac.mp4'), { fps: { min: 24 } }).violations[0]!.message).toBe('fps: unknown, no video track');
  });
});
