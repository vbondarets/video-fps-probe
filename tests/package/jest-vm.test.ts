import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JEST_FIXTURE, expectedRun, installTarball, jestOrReason, jestProject, relativeToPackage, runJest } from './jest-project.ts';

const PROJECT = jestProject('jest-vm');
const [major, minor] = process.versions.node.split('.').map(Number) as [number, number];
const SYNC_ESM = major > 24 || (major === 24 && minor >= 9);
const SKIPPED = SYNC_ESM ? jestOrReason(PROJECT) : `Jest loads ESM from require() only on Node 24.9 and later, this is Node ${process.versions.node}`;
if (SKIPPED && SYNC_ESM && process.env.CI) throw new Error(SKIPPED);
if (SKIPPED) console.warn(`skipping the Jest vm modules package test: ${SKIPPED}`);

describe.skipIf(SKIPPED !== null)('the packed tarball under Jest with --experimental-vm-modules', () => {
  let remove = (): void => {};

  beforeAll(() => {
    remove = installTarball(PROJECT);
  });

  afterAll(() => remove());

  it('runs the same test file as the plain Jest project', () => {
    expect(readFileSync(join(PROJECT.dir, 'server.test.js'), 'utf8')).toBe(readFileSync(join(PROJECT.dir, '..', 'jest-plain', 'server.test.js'), 'utf8'));
  });

  it(`loads the ESM server entries from require() and gives the source results on Node ${process.versions.node}`, async () => {
    const out = runJest(PROJECT, { JEST_FIXTURE, NODE_OPTIONS: '--experimental-vm-modules' }) as Record<string, unknown>;
    expect(relativeToPackage(out.resolved)).toEqual(['dist/index.js', 'dist/header/index.js', 'dist/url/index.js', 'dist/color/index.js', 'dist/aspect/index.js', 'dist/check/index.js', 'dist/presets/index.js']);
    const { resolved: _, ...rest } = out;
    expect(rest).toEqual(await expectedRun());
  });
});
