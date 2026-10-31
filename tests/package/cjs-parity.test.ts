import { openAsBlob } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type * as Check from '../../src/check/index.ts';
import type * as Header from '../../src/header/index.ts';
import type * as Root from '../../src/index.ts';
import type * as Presets from '../../src/presets/index.ts';
import type * as Url from '../../src/url/index.ts';
import { CJS_ENTRIES } from '../../scripts/build-lib.mjs';
import { FILES_DIR, REPO_ROOT, loadManifest } from '../helpers/fixtures.ts';

const DIST = join(REPO_ROOT, 'dist');
const load = createRequire(import.meta.url);

const pairs = Object.fromEntries(
  await Promise.all(Object.entries(CJS_ENTRIES).map(async ([name, file]) => [name, { esm: (await import(pathToFileURL(join(DIST, file)).href)) as Record<string, unknown>, cjs: load(join(DIST, 'cjs', `${name}.cjs`)) as Record<string, unknown> }] as const)),
);
const esm = { root: pairs.index!.esm as unknown as typeof Root, header: pairs.header!.esm as unknown as typeof Header, check: pairs.check!.esm as unknown as typeof Check, presets: pairs.presets!.esm as unknown as typeof Presets, url: pairs.url!.esm as unknown as typeof Url };
const cjs = { root: pairs.index!.cjs as unknown as typeof Root, header: pairs.header!.cjs as unknown as typeof Header, check: pairs.check!.cjs as unknown as typeof Check, presets: pairs.presets!.cjs as unknown as typeof Presets, url: pairs.url!.cjs as unknown as typeof Url };

const fixtures = loadManifest().filter((e) => e.committed).map((e) => e.name);
const withoutMs = <T extends { io: object }>(r: T): T => ({ ...r, io: { ...r.io, ms: 0 } });

describe('the CommonJS copy against the ESM build', () => {
  it('covers the five server entries, each a separate copy', () => {
    expect(Object.keys(pairs)).toEqual(['index', 'header', 'url', 'check', 'presets']);
    for (const [name, { esm: e, cjs: c }] of Object.entries(pairs)) {
      const key = Object.keys(e).find((k) => typeof e[k] === 'function' || typeof e[k] === 'object')!;
      expect(c[key], `${name} ${key}`).toBeDefined();
      expect(c[key], `${name} ${key}`).not.toBe(e[key]);
    }
  });

  it.each(Object.keys(CJS_ENTRIES))('%s exports the same names with the same kinds', (name) => {
    const { esm: e, cjs: c } = pairs[name]!;
    expect(Object.keys(c).sort()).toEqual(Object.keys(e).sort());
    expect(Object.keys(c).map((k) => typeof c[k])).toEqual(Object.keys(c).map((k) => typeof e[k]));
  });

  it('keeps the constant data equal', () => {
    expect(cjs.header.HEADER_DEFAULT_LIMITS).toEqual(esm.header.HEADER_DEFAULT_LIMITS);
    expect(Object.isFrozen(cjs.header.HEADER_DEFAULT_LIMITS)).toBe(true);
    const presets = Object.keys(esm.presets) as (keyof typeof Presets)[];
    for (const p of presets) expect(cjs.presets[p], p).toEqual(esm.presets[p]);
    expect(new cjs.root.ProbeError('timeout', 'x')).toMatchObject({ name: 'ProbeError', code: 'timeout' });
    expect(new cjs.url.RangeSourceError('size-changed', 'x', { status: 206 })).toMatchObject({ name: 'RangeSourceError', code: 'size-changed', status: 206 });
  });

  it.each(fixtures)('%s: analyze, analyzeHeader, a Range source and check give the ESM results', async (name) => {
    const blob = await openAsBlob(join(FILES_DIR, name));
    const [e, c] = await Promise.all([esm.root.analyze(blob, { name }), cjs.root.analyze(blob, { name })]);
    expect(withoutMs(c)).toEqual(withoutMs(e));
    const [eh, ch] = await Promise.all([esm.header.analyzeHeader(blob, { name }), cjs.header.analyzeHeader(blob, { name })]);
    expect(withoutMs(ch)).toEqual(withoutMs(eh));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const fetcher: Url.RangeFetcher = async ({ start, end }) => ({ status: 206, contentRange: `bytes ${start}-${end - 1}/${bytes.byteLength}`, bytes: bytes.subarray(start, end) });
    expect(withoutMs(await cjs.header.analyzeHeader(cjs.url.rangeSource(fetcher, { size: bytes.byteLength }), { name }))).toEqual(withoutMs(eh));
    for (const preset of Object.values(esm.presets)) expect(cjs.check.check(c, preset.rules)).toEqual(esm.check.check(e, preset.rules));
    expect(cjs.root.errorCodeOf(c)).toBe(esm.root.errorCodeOf(e));
    expect(cjs.root.warningCodesOf(c)).toEqual(esm.root.warningCodesOf(e));
  });
});
