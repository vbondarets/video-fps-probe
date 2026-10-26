import { openAsBlob } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyze, DEFAULT_LOADERS } from '../../src/core/analyze.ts';
import { analyzeWith, isAbortError } from '../../src/core/dispatch.ts';
import type { FileResult } from '../../src/core/types.ts';
import { FILES_DIR, loadManifest } from '../helpers/fixtures.ts';

const fixtures = loadManifest().filter((e) => e.committed);

const untimed = (r: FileResult) => ({ ...r, io: { ...r.io, ms: 0 } });

describe('analyzeWith', () => {
  it('covers the committed corpus', () => {
    expect(fixtures.length).toBeGreaterThan(100);
  });

  it.each(fixtures.map((e) => e.name))('%s: with the default loaders equals analyze()', async (name) => {
    const blob = await openAsBlob(join(FILES_DIR, name));
    const [expected, actual] = await Promise.all([analyze(blob, name), analyzeWith(blob, name, {}, (kind) => DEFAULT_LOADERS[kind]())]);
    expect(untimed(actual)).toEqual(untimed(expected));
  });

  it('turns an analyzer that fails to load into an error result with the sniffed container', async () => {
    const blob = new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0, 0, 0])]);
    const result = await analyzeWith(blob, 'a.webm', {}, () => Promise.reject(new Error('chunk gone')));
    expect(result).toMatchObject({ container: 'matroska', error: 'chunk gone', engine: 'own' });
  });
});

describe('isAbortError', () => {
  it('reads the name of anything thrown, without throwing for null, undefined or a primitive', () => {
    expect(isAbortError(new DOMException('stop', 'AbortError'))).toBe(true);
    expect(isAbortError({ name: 'AbortError' })).toBe(true);
    for (const other of [new Error('x'), { name: 'TimeoutError' }, null, undefined, 'AbortError', 0, Symbol('AbortError')]) expect(isAbortError(other)).toBe(false);
  });
});
