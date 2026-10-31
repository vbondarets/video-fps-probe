import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { errorClass, errorCodeOf, warningCodeOf, warningCodesOf, type ErrorClass } from '../../src/api/codes.ts';
import { emptyAnalysis, emptyTrack } from '../../src/core/result.ts';
import type { FileErrorCode, FileResult } from '../../src/core/types.ts';
import { OWN_SNAPSHOT, committedFixtures, ownResultOf, type OwnSnapshot } from '../../scripts/own-snapshot.ts';
import * as root from '../../src/index.ts';

const snapshot = JSON.parse(readFileSync(OWN_SNAPSHOT, 'utf8')) as OwnSnapshot;

const CLASSES: ReadonlyArray<readonly [FileErrorCode, ErrorClass]> = [
  ['empty-file', 'file'],
  ['unrecognised', 'file'],
  ['unsupported-container', 'file'],
  ['unsupported', 'file'],
  ['too-large', 'file'],
  ['no-header', 'file'],
  ['truncated', 'file'],
  ['corrupt', 'file'],
  ['no-duration', 'file'],
  ['engine-failed', 'file'],
  ['byte-limit', 'limit'],
  ['read-limit', 'limit'],
  ['time-limit', 'limit'],
  ['structure-limit', 'limit'],
  ['read-failed', 'io'],
  ['load-failed', 'environment'],
  ['internal', 'internal'],
];

const MESSAGES: ReadonlyArray<readonly [string, FileErrorCode]> = [
  ['not a recognised container: empty file', 'empty-file'],
  ['not a recognised container: no known signature', 'unrecognised'],
  ['not a recognised container', 'unrecognised'],
  ['the own Matroska worker does not read ISO BMFF', 'unsupported-container'],
  ['the own ISO BMFF worker does not read Matroska', 'unsupported-container'],
  ['unsupported by mp4box', 'unsupported-container'],
  ['container not read by the header entry: webm', 'unsupported-container'],
  ['unsupported: compressed movie header (cmov)', 'unsupported'],
  ["unsupported: box 'elst' at 1234 holds a value above 2^53-1", 'unsupported'],
  ["unsupported: box 'tfdt' at 99 holds a value beyond 2^53-1", 'unsupported'],
  ['unsupported: moov larger than 256 MiB', 'too-large'],
  ['corrupt file: moof larger than 64 MiB at 4096', 'too-large'],
  ['incomplete file: no moov', 'no-header'],
  ['no Segment element', 'no-header'],
  ['no Tracks element found', 'no-header'],
  ['incomplete file: moov is truncated', 'truncated'],
  ['no complete TrackEntry in Tracks', 'truncated'],
  ["corrupt file: box 'free' at 8 is smaller than its header", 'corrupt'],
  ["corrupt file: box 'mdat' at 8 has a size above 2^53-1", 'corrupt'],
  ['corrupt file: movie fragment (moof) before moov', 'corrupt'],
  ['corrupt file: no sample duration for track 1', 'corrupt'],
  ["corrupt file: box 'sidx' at 100 is truncated", 'corrupt'],
  ['corrupt file: Offset is outside the bounds of the DataView', 'corrupt'],
  ['invalid EBML header', 'corrupt'],
  ['incomplete header: fragmented file without a sidx, mfra or mehd duration', 'no-duration'],
  ['limit reached: maxBytes 1024 (4096 more bytes needed at offset 0)', 'byte-limit'],
  ['limit reached: maxReads 3', 'read-limit'],
  ['limit reached: maxMs 2500', 'time-limit'],
  ['limit reached: maxTracks 16', 'structure-limit'],
  ['limit reached: maxTopLevelBoxes 32', 'structure-limit'],
  ['file read failed: Error: disk gone', 'read-failed'],
  ['file read failed: short read at 0: expected 100 bytes, got 10', 'read-failed'],
];

function result(warnings: string[], trackWarnings: string[][]): Pick<FileResult, 'warnings' | 'videoTracks'> {
  return { warnings, videoTracks: trackWarnings.map((w, i) => ({ ...emptyTrack(i + 1), warnings: w })) };
}

describe('errorCodeOf', () => {
  test('returns the errorCode of the result when it has one, null included', () => {
    expect(errorCodeOf({ error: 'corrupt file: x', errorCode: 'truncated' })).toBe('truncated');
    expect(errorCodeOf({ error: null, errorCode: null })).toBeNull();
    expect(errorCodeOf({ error: null })).toBeNull();
  });

  test.each(MESSAGES)('classifies %s', (message, code) => {
    expect(errorCodeOf({ error: message, engine: 'own' })).toBe(code);
  });

  test('gives engine-failed to an unknown text of another engine and internal to an unknown own text', () => {
    expect(errorCodeOf({ error: 'Unsupported codec', engine: 'mediabunny' })).toBe('engine-failed');
    expect(errorCodeOf({ error: 'BoxParser error', engine: 'mp4box' })).toBe('engine-failed');
    expect(errorCodeOf({ error: 'NotSupportedError', engine: 'rvfc' })).toBe('engine-failed');
    expect(errorCodeOf({ error: 'something new', engine: 'own' })).toBe('internal');
    expect(errorCodeOf({ error: 'something new' })).toBe('internal');
    expect(errorCodeOf({ error: 'file read failed: Error: gone', engine: 'mp4box' })).toBe('read-failed');
  });

  test('classifies every 0.3.0 error of the corpus as the parser codes it', async () => {
    const failed = committedFixtures().filter((n) => snapshot.results[n]?.error);
    expect(failed.length).toBeGreaterThan(0);
    for (const name of failed) {
      const now = await ownResultOf(name);
      const was = snapshot.results[name] as FileResult;
      expect(errorCodeOf({ error: was.error, engine: was.engine }), name).toBe(now.errorCode);
    }
  });

  test('classifies the result of a 0.3.0 client fallback', () => {
    expect(errorCodeOf({ ...emptyAnalysis('mp4', 'unsupported by mp4box'), engine: 'mp4box' })).toBe('unsupported-container');
    expect(errorCodeOf({ ...emptyAnalysis('unknown', 'not a recognised container'), engine: 'mediabunny' })).toBe('unrecognised');
  });
});

describe('errorClass', () => {
  test.each(CLASSES)('%s is %s', (code, cls) => {
    expect(errorClass(code)).toBe(cls);
  });

  test('a code from a later version is internal', () => {
    expect(errorClass('quota-exceeded' as FileErrorCode)).toBe('internal');
    expect(errorClass('constructor' as FileErrorCode)).toBe('internal');
  });
});

describe('warningCodeOf', () => {
  test('classifies the four frozen prefixes', () => {
    expect(warningCodeOf('invalid mdhd timescale 0, using 1')).toBe('invalid-timescale');
    expect(warningCodeOf('invalid timescale -5, using 1')).toBe('invalid-timescale');
    expect(warningCodeOf("'mdat' at 3969 is truncated")).toBe('truncated-mdat');
    expect(warningCodeOf("'moov' at 87638 is truncated")).toBe('truncated-box');
    expect(warningCodeOf("'a'b?' at 0 is truncated")).toBe('truncated-box');
    expect(warningCodeOf("'mdat' at 3969 is truncated, and more")).toBe('truncated-mdat');
    expect(warningCodeOf('ignored trailing data at 88446: not a box')).toBe('trailing-data');
    expect(warningCodeOf("ignored trailing data at 12: corrupt file: box 'abcd' at 12 is smaller than its header")).toBe('trailing-data');
  });

  test('classifies the prefixes of the header warnings', () => {
    expect(warningCodeOf('fragment index not read: limit reached: maxReads 3')).toBe('fragment-index-unread');
    expect(warningCodeOf('format duration unresolved: track 2')).toBe('duration-unresolved');
    expect(warningCodeOf('format duration unresolved: track 2 (3 times)')).toBe('duration-unresolved');
    expect(warningCodeOf('fragments ignored: moof at 962 after a moov without an mvex')).toBe('fragments-ignored');
    expect(warningCodeOf('too many top-level boxes')).toBe('structure-limit');
  });

  test('leaves every other warning as free text', () => {
    for (const w of [
      'moov size exceeds the file; parsed what is there',
      "'stts' overruns 'stbl'",
      'truncated: 53 of 90 samples complete',
      'truncated file: the last Cluster or block ends beyond EOF',
      "corrupt file: box 'sidx' at 100 is truncated",
      'mdhd timescale 0',
      'walk stopped: too many top-level boxes',
      'ffprobe 8.1.1 rejects this file: trun without a tfhd that has a trex',
      '',
    ]) {
      expect(warningCodeOf(w), w).toBeNull();
    }
  });

  test('every warning of the corpus is classified the same way as its text says', () => {
    const seen = new Map<string, string | null>();
    for (const r of Object.values(snapshot.results)) for (const w of [...r.warnings, ...r.videoTracks.flatMap((t) => t.warnings)]) seen.set(w, warningCodeOf(w));
    const coded = [...seen].filter(([, c]) => c !== null);
    expect(coded.map(([, c]) => c).sort()).toEqual(expect.arrayContaining(['trailing-data', 'truncated-box', 'truncated-mdat']));
    for (const [w, c] of coded) expect(w.startsWith('ignored trailing data at ') || / is truncated$/.test(w) || /timescale/.test(w), `${w} -> ${c}`).toBe(true);
  });
});

describe('warningCodesOf', () => {
  test('collects the codes of the file and its tracks once each, in the order first seen', () => {
    const r = result(["'mdat' at 10 is truncated", 'ignored trailing data at 99: not a box', "'mdat' at 50 is truncated"], [['invalid mdhd timescale 0, using 1', 'free text'], ["'mdat' at 10 is truncated"]]);
    expect(warningCodesOf(r)).toEqual(['truncated-mdat', 'trailing-data', 'invalid-timescale']);
    expect(warningCodesOf(result(['free text'], [[]]))).toEqual([]);
  });

  test('finds truncated-mdat on the truncated fixtures of the corpus', () => {
    const truncated = Object.entries(snapshot.results).filter(([, r]) => r.warnings.some((w) => /^'mdat' at \d+ is truncated$/.test(w)));
    expect(truncated.length).toBeGreaterThan(0);
    for (const [name, r] of truncated) expect(warningCodesOf(r), name).toContain('truncated-mdat');
  });
});

describe('values outside the types', () => {
  test('never throw: a value that is not a result or a warning gives internal, null or no code', () => {
    const loose = (v: unknown) => v as Parameters<typeof errorCodeOf>[0];
    expect(errorCodeOf(loose(null))).toBe('internal');
    expect(errorCodeOf(loose({}))).toBe('internal');
    expect(errorCodeOf(loose({ error: undefined }))).toBe('internal');
    expect(errorCodeOf(loose({ error: 42 }))).toBe('internal');
    expect(errorCodeOf(loose({ code: 'timeout', message: 'timed out' }))).toBe('internal');
    expect(warningCodeOf(7 as unknown as string)).toBeNull();
    expect(warningCodeOf(null as unknown as string)).toBeNull();
    const looseResult = (v: unknown) => v as Parameters<typeof warningCodesOf>[0];
    expect(warningCodesOf(looseResult(null))).toEqual([]);
    expect(warningCodesOf(looseResult({}))).toEqual([]);
    expect(warningCodesOf(looseResult({ warnings: ["'mdat' at 1 is truncated", 3], videoTracks: [null, {}, { warnings: 'x' }] }))).toEqual(['truncated-mdat']);
  });
});

describe('root entry', () => {
  test('exports the code helpers', () => {
    expect([root.errorCodeOf, root.errorClass, root.warningCodeOf, root.warningCodesOf]).toEqual([errorCodeOf, errorClass, warningCodeOf, warningCodesOf]);
  });
});
