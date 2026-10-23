import { openAsBlob } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as src from '../../src/index.ts';
import type { ProbeResult } from '../../src/index.ts';
import { FILES_DIR, loadManifest } from '../helpers/fixtures.ts';

const DIST_ENTRY = new URL('../../dist/index.js', import.meta.url).href;
const dist = (await import(DIST_ENTRY)) as typeof src;

const fixtures = loadManifest().filter((e) => e.committed);
const matroska = fixtures.filter((e) => e.container === 'matroska' || e.container === 'webm');

const withoutTiming = (r: ProbeResult) => ({ ...r, io: { reads: r.io.reads, bytesRead: r.io.bytesRead } });

async function both(name: string, options: src.InThreadOptions = {}): Promise<[ProbeResult, ProbeResult]> {
  const blob = await openAsBlob(join(FILES_DIR, name));
  return Promise.all([src.analyze(blob, { ...options, name }), dist.analyze(blob, { ...options, name })]);
}

describe('dist parity', () => {
  it('loads the built entry, not the source modules', () => {
    expect(fixtures.length).toBeGreaterThan(100);
    expect(matroska.length).toBeGreaterThan(10);
    expect(dist.analyze).not.toBe(src.analyze);
    expect(Object.keys(dist).sort()).toEqual(Object.keys(src).sort());
  });

  it.each(fixtures.map((e) => e.name))('%s: dist analyze equals src analyze', async (name) => {
    const [expected, actual] = await both(name);
    expect(withoutTiming(actual)).toEqual(withoutTiming(expected));
  });

  it.each(matroska.map((e) => e.name))('%s: dist analyze equals src analyze with matroskaMode exact', async (name) => {
    const [expected, actual] = await both(name, { matroskaMode: 'exact' });
    expect(withoutTiming(actual)).toEqual(withoutTiming(expected));
  });
});
