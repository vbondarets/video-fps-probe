import { openAsBlob } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/core/analyze.ts';
import { analyzeIsoBmff } from '../../src/core/isobmff/index.ts';
import { analyzeMatroska } from '../../src/core/matroska/index.ts';
import { containerFamily } from '../../src/core/sniff.ts';
import type { FileResult } from '../../src/core/types.ts';
import type { ContainerFamily } from '../../src/plugins/types.ts';
import { singleContainerEngine, wrongFamily } from '../../src/worker/single.ts';
import { FILES_DIR, loadManifest } from '../helpers/fixtures.ts';

const fixtures = loadManifest().filter((e) => e.committed);
const engines: Record<ContainerFamily, ReturnType<typeof singleContainerEngine>> = {
  isobmff: singleContainerEngine('isobmff', analyzeIsoBmff),
  matroska: singleContainerEngine('matroska', analyzeMatroska),
};
const other = (family: ContainerFamily): ContainerFamily => (family === 'isobmff' ? 'matroska' : 'isobmff');
const untimed = (r: FileResult) => ({ ...r, io: { ...r.io, ms: 0 } });

describe('single-container own engines', () => {
  it('cover every container family of the corpus, and files no family reads', () => {
    expect(new Set(fixtures.map((e) => e.container))).toEqual(new Set(['mp4', 'mov', 'webm', 'matroska', 'unknown']));
  });

  it.each(fixtures.map((e) => e.name))('%s: the engine of its family equals analyze(), the other one keeps the container and fails', async (name) => {
    const blob = await openAsBlob(join(FILES_DIR, name));
    const expected = await analyze(blob, name);
    const family = await containerFamily(blob);
    if (family === null) {
      for (const engine of Object.values(engines)) expect(untimed(await engine.run(blob, name, {}))).toEqual(untimed(expected));
      return;
    }
    expect(untimed(await engines[family].run(blob, name, {}))).toEqual(untimed(expected));
    const wrong = await engines[other(family)].run(blob, name, {});
    expect(wrong).toMatchObject({ name, size: blob.size, engine: 'own', container: family === 'isobmff' ? 'mp4' : 'matroska', error: wrongFamily(other(family), family), videoTracks: [] });
    expect(wrong.io.reads).toBeGreaterThan(0);
  });

  it('give the error text of analyze() for an empty file and a PNG', async () => {
    const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])]);
    for (const blob of [new Blob([]), png]) {
      const expected = await analyze(blob, 'x');
      expect(expected.error).toMatch(/^not a recognised container: /);
      for (const engine of Object.values(engines)) expect(untimed(await engine.run(blob, 'x', {}))).toEqual(untimed(expected));
    }
  });

  it('name both families in the wrong-family error', () => {
    expect(wrongFamily('isobmff', 'matroska')).toBe('the own ISO BMFF worker does not read Matroska');
    expect(wrongFamily('matroska', 'isobmff')).toBe('the own Matroska worker does not read ISO BMFF');
  });
});
