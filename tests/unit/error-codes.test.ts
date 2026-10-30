import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import { analyze } from '../../src/core/analyze.ts';
import { analyzeWith } from '../../src/core/dispatch.ts';
import { IsoBmffError } from '../../src/core/isobmff/boxes.ts';
import { whichErrorCode, withErrorCode, type BlobLike } from '../../src/core/reader.ts';
import type { ContainerAnalyzer, FileErrorCode, FileResult } from '../../src/core/types.ts';
import { singleContainerEngine } from '../../src/worker/single.ts';
import { OWN_SNAPSHOT, committedFixtures, ownResultOf, type OwnSnapshot } from '../../scripts/own-snapshot.ts';
import { REPO_ROOT, loadManifest } from '../helpers/fixtures.ts';

const CODES: readonly FileErrorCode[] = [
  'empty-file',
  'unrecognised',
  'unsupported-container',
  'unsupported',
  'too-large',
  'no-header',
  'truncated',
  'corrupt',
  'no-duration',
  'byte-limit',
  'read-limit',
  'time-limit',
  'structure-limit',
  'read-failed',
  'load-failed',
  'engine-failed',
  'internal',
];

const MP4_HEAD = Uint8Array.from([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0]);

const snapshot = JSON.parse(readFileSync(OWN_SNAPSHOT, 'utf8')) as OwnSnapshot;
const names = committedFixtures();
const results = new Map<string, FileResult>();

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

function failingBlob(size: number, fail: () => Promise<ArrayBuffer>): BlobLike {
  return { size, slice: () => ({ arrayBuffer: fail }) };
}

const run = (blob: BlobLike, analyzerOf: Parameters<typeof analyzeWith>[3]) => analyzeWith(blob, 'synthetic.mp4', {}, analyzerOf);

const analyzerThrowing =
  (e: unknown): ContainerAnalyzer =>
  async () => {
    throw e;
  };

beforeAll(async () => {
  for (const name of names) results.set(name, await ownResultOf(name));
}, 300_000);

describe('error codes over the committed fixtures', () => {
  test('every manifest error row gets the code the manifest names', () => {
    const rows = loadManifest().filter((m) => m.committed && m.expect === 'error');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.columns.code, row.name).toBeTruthy();
      expect(results.get(row.name)?.errorCode, row.name).toBe(row.columns.code);
    }
  });

  test('error is null exactly when errorCode is null, and every code is in the closed list', () => {
    for (const [name, r] of results) {
      expect(r.errorCode === null, name).toBe(r.error === null);
      if (r.errorCode !== null) expect(CODES, name).toContain(r.errorCode);
    }
  });

  test('no committed fixture yields internal', () => {
    expect([...results].filter(([, r]) => r.errorCode === 'internal').map(([n]) => n)).toEqual([]);
  });

  test('every error message equals the 0.3.0 snapshot', () => {
    const shared = Object.keys(snapshot.results).filter((n) => results.has(n));
    expect(shared.length).toBe(Object.keys(snapshot.results).length);
    for (const name of shared) expect(results.get(name)?.error, name).toBe(snapshot.results[name].error);
  });
});

describe('error codes at the throw sites', () => {
  test('the empty file and an unknown signature', async () => {
    expect(await analyze(new Blob([]), 'empty.mp4')).toMatchObject({ error: 'not a recognised container: empty file', errorCode: 'empty-file' });
    expect(await analyze(new Blob(['hello world, this is no video at all']), 'text.mp4')).toMatchObject({ error: 'not a recognised container: text file', errorCode: 'unrecognised' });
  });

  test('a read that fails or comes back short is read-failed with the 0.3.0 message', async () => {
    const failed = await run(
      failingBlob(100, () => Promise.reject(new Error('disk gone'))),
      () => {
        throw new Error('not reached');
      },
    );
    expect(failed).toMatchObject({ error: 'file read failed: Error: disk gone', errorCode: 'read-failed' });
    const short = await run(
      failingBlob(100, async () => new ArrayBuffer(10)),
      () => {
        throw new Error('not reached');
      },
    );
    expect(short).toMatchObject({ error: 'file read failed: short read at 0: expected 100 bytes, got 10', errorCode: 'read-failed' });
  });

  test('invalid caller input is internal, never a file code, and keeps its 0.3.0 text', async () => {
    const notReached = () => {
      throw new Error('not reached');
    };
    for (const size of [-1, Number.NaN, 2 ** 53]) {
      const r = await run({ size, slice: () => new Blob([]) }, notReached);
      expect(r).toMatchObject({ error: `blob size must be a non-negative safe integer, got ${size}`, errorCode: 'internal' });
    }
    const valid = readFileSync(join(REPO_ROOT, 'fixtures', 'files', 'edge_single_frame.mp4'));
    expect(await analyze(new Blob([valid]), 'valid.mp4', { readAhead: { head: -1 } })).toMatchObject({
      error: 'headWindow must be a non-negative safe integer, got -1',
      errorCode: 'internal',
    });
    const fragmented = readFileSync(join(REPO_ROOT, 'fixtures', 'files', 'fmp4_frag_duration.mp4'));
    expect(await analyze(new Blob([fragmented]), 'fragmented.mp4', { readAhead: { fragment: -1 } })).toMatchObject({
      error: 'corrupt file: readAhead must be a non-negative safe integer, got -1',
      errorCode: 'internal',
    });
  });

  test('a parser that fails to load is load-failed, a thrown error after it is coded by its kind', async () => {
    const blob = new Blob([MP4_HEAD]);
    expect(
      await run(blob, async () => {
        throw new TypeError('Failed to fetch dynamically imported module');
      }),
    ).toMatchObject({ error: 'Failed to fetch dynamically imported module', errorCode: 'load-failed' });
    expect(await run(blob, () => analyzerThrowing(new TypeError('a bug')))).toMatchObject({ error: 'a bug', errorCode: 'internal' });
    expect(await run(blob, () => analyzerThrowing(new RangeError('Offset is outside the bounds of the DataView')))).toMatchObject({ errorCode: 'corrupt' });
    expect(await run(blob, () => analyzerThrowing(withErrorCode('truncated', 'no complete TrackEntry in Tracks')))).toMatchObject({ error: 'no complete TrackEntry in Tracks', errorCode: 'truncated' });
    expect(await run(blob, () => analyzerThrowing('a string'))).toMatchObject({ error: 'a string', errorCode: 'internal' });
  });

  test('a single-family worker given the other family is unsupported-container', async () => {
    const engine = singleContainerEngine('matroska', async () => {
      throw new Error('not reached');
    });
    expect(await engine.run(new Blob([MP4_HEAD]), 'a.mp4', {})).toMatchObject({ error: 'the own Matroska worker does not read ISO BMFF', errorCode: 'unsupported-container' });
  });

  test('the coded errors keep their 0.3.0 name and message', () => {
    const iso = new IsoBmffError('unsupported', 'unsupported: compressed movie header (cmov)');
    expect([iso.name, iso.message, iso.errorCode, iso instanceof Error]).toEqual(['IsoBmffError', 'unsupported: compressed movie header (cmov)', 'unsupported', true]);
    const plain = withErrorCode('no-header', 'no Segment element');
    expect([plain.name, plain.message, (plain as Error & { errorCode?: string }).errorCode]).toEqual(['Error', 'no Segment element', 'no-header']);
  });

  test('a thrown value is coded by its errorCode, then RangeError, then the fallback', () => {
    expect(whichErrorCode(withErrorCode('read-failed', 'x'))).toBe('read-failed');
    expect(whichErrorCode(new RangeError('x'))).toBe('corrupt');
    expect(whichErrorCode(new Error('x'))).toBe('internal');
    expect(whichErrorCode(new Error('x'), 'load-failed')).toBe('load-failed');
    expect(whichErrorCode(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe('internal');
    expect(whichErrorCode(null)).toBe('internal');
    expect(whichErrorCode('x')).toBe('internal');
  });
});

describe('error codes in the sources', () => {
  const files = [...sourceFiles(join(REPO_ROOT, 'src', 'core')), ...sourceFiles(join(REPO_ROOT, 'src', 'worker'))];
  const calls = (pattern: RegExp) =>
    files.flatMap((f) => {
      const text = readFileSync(f, 'utf8');
      return [...text.matchAll(pattern)].map((m) => ({ at: `${relative(REPO_ROOT, f)}:${text.slice(0, m.index).split('\n').length}`, code: m[1] ?? null }));
    });

  test('every IsoBmffError passes a code of the closed list', () => {
    const sites = calls(/new IsoBmffError\(\s*(?:'([^']*)')?/g);
    expect(sites.length).toBeGreaterThanOrEqual(13);
    for (const s of sites) expect(CODES, s.at).toContain(s.code);
  });

  test('every withErrorCode call passes a code of the closed list', () => {
    const sites = calls(/(?<!function )withErrorCode\(\s*(?:'([^']*)')?/g);
    expect(sites.length).toBeGreaterThanOrEqual(9);
    for (const s of sites) expect(CODES, s.at).toContain(s.code);
  });

  test('no plain Error is thrown in the parsers or the reader', () => {
    const plain = files
      .filter((f) => /[\\/](isobmff|matroska)[\\/]|[\\/]reader\.ts$|[\\/]dispatch\.ts$/.test(f))
      .flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/throw (?:new )?Error\(/g)].map(() => relative(REPO_ROOT, f)));
    expect(plain).toEqual([]);
  });
});
