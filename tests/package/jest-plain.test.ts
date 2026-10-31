import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JEST_FIXTURE, expectedRun, installTarball, jestOrReason, jestProject, relativeToPackage, runJest } from './jest-project.ts';

const PROJECT = jestProject('jest-plain');
const SKIPPED = jestOrReason(PROJECT);
if (SKIPPED && process.env.CI) throw new Error(SKIPPED);
if (SKIPPED) console.warn(`skipping the plain Jest package test: ${SKIPPED}`);

describe.skipIf(SKIPPED !== null)('the packed tarball under Jest with no configuration', () => {
  let remove = (): void => {};

  beforeAll(() => {
    remove = installTarball(PROJECT);
  });

  afterAll(() => remove());

  it('installs only jest and has no Jest configuration', () => {
    const manifest = JSON.parse(readFileSync(join(PROJECT.dir, 'package.json'), 'utf8')) as Record<string, unknown>;
    expect(manifest.dependencies).toEqual({ jest: '30.5.2' });
    expect(Object.keys(manifest).filter((k) => ['jest', 'babel', 'devDependencies'].includes(k))).toEqual([]);
  });

  it(`loads the CommonJS copies of the server entries without vm modules and gives the source results on Node ${process.versions.node}`, async () => {
    const out = runJest(PROJECT, { JEST_FIXTURE }) as Record<string, unknown>;
    expect(relativeToPackage(out.resolved)).toEqual(['dist/cjs/index.cjs', 'dist/cjs/header.cjs', 'dist/cjs/url.cjs', 'dist/cjs/check.cjs', 'dist/cjs/presets.cjs']);
    const { resolved: _, ...rest } = out;
    expect(rest).toEqual(await expectedRun());
  });
});
