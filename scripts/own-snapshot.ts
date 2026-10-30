import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { check, type CheckReport } from '../src/check/index.ts';
import { analyze } from '../src/core/analyze.ts';
import type { FileResult } from '../src/core/types.ts';
import * as presets from '../src/presets/index.ts';
import type { ProviderPreset } from '../src/presets/index.ts';
import { REPO_ROOT, fixturePath, loadManifest } from '../tests/helpers/fixtures.ts';
import { openFixture } from '../tests/helpers/open-blob.ts';

export const OWN_SNAPSHOT = join(REPO_ROOT, 'fixtures', 'snapshots', 'own-v0.3.0.json');
export const CHECK_SNAPSHOT = join(REPO_ROOT, 'fixtures', 'snapshots', 'check-v0.3.0.json');

export interface OwnSnapshot {
  version: string;
  note: string;
  results: Record<string, FileResult>;
}

export interface CheckSnapshot {
  version: string;
  note: string;
  presets: string[];
  reports: Record<string, Record<string, CheckReport>>;
}

const USAGE = `Usage: node scripts/own-snapshot.ts --write [--force]

Writes fixtures/snapshots/own-v0.3.0.json, the own result of every committed fixture without
io.ms, and fixtures/snapshots/check-v0.3.0.json, the check() report of every preset over those
results. They are the 0.3.0 baselines of tests/regression/own-snapshot.test.ts: write them once,
from the 0.3.0 sources, and never again. --force overwrites existing files.
`;

const json = (v: unknown): string => JSON.stringify(v);

export function serializeSnapshot(head: Record<string, unknown>, key: string, map: Record<string, unknown>, nested: boolean): string {
  const lines = Object.entries(head).map(([k, v]) => ` ${json(k)}: ${json(v)},`);
  const entries = Object.entries(map).map(([name, value]) => {
    if (!nested) return `  ${json(name)}: ${json(value)}`;
    const inner = Object.entries(value as Record<string, unknown>).map(([k, v]) => `   ${json(k)}: ${json(v)}`);
    return [`  ${json(name)}: {`, inner.join(',\n'), '  }'].join('\n');
  });
  return ['{', ...lines, ` ${json(key)}: {`, entries.join(',\n'), ' }', '}', ''].join('\n');
}

export function presetEntries(): [string, ProviderPreset][] {
  return Object.entries(presets)
    .filter((e): e is [string, ProviderPreset] => typeof e[1] === 'object' && e[1] !== null && 'rules' in e[1])
    .sort(([a], [b]) => a.localeCompare(b));
}

export function committedFixtures(): string[] {
  return loadManifest()
    .filter((m) => m.committed)
    .map((m) => m.name);
}

export function snapshotForm(result: FileResult): FileResult {
  const plain = JSON.parse(JSON.stringify(result)) as { io?: Record<string, unknown> };
  if (plain.io) delete plain.io.ms;
  return plain as unknown as FileResult;
}

export async function ownResultOf(name: string): Promise<FileResult> {
  const path = fixturePath(name);
  if (!path) throw new Error(`fixture ${name} is missing`);
  const opened = await openFixture(path);
  try {
    return snapshotForm(await analyze(opened.blob, name));
  } finally {
    await opened.close();
  }
}

export function checkReportsOf(result: FileResult): Record<string, CheckReport> {
  return Object.fromEntries(presetEntries().map(([name, p]) => [name, JSON.parse(JSON.stringify(check(result, p.rules))) as CheckReport]));
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { write: { type: 'boolean', default: false }, force: { type: 'boolean', default: false }, help: { type: 'boolean', default: false } }, strict: true });
  if (values.help || !values.write) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }
  if (!values.force && (existsSync(OWN_SNAPSHOT) || existsSync(CHECK_SNAPSHOT))) {
    console.error('the snapshots exist already: they are the 0.3.0 baselines, pass --force only to replace them on purpose');
    return 1;
  }
  const results: Record<string, FileResult> = {};
  const reports: Record<string, Record<string, CheckReport>> = {};
  for (const name of committedFixtures()) {
    results[name] = await ownResultOf(name);
    reports[name] = checkReportsOf(results[name]);
  }
  const version = '0.3.0';
  const names = presetEntries().map(([n]) => n);
  mkdirSync(dirname(OWN_SNAPSHOT), { recursive: true });
  writeFileSync(OWN_SNAPSHOT, serializeSnapshot({ version, note: 'analyze() with default options on every committed fixture, io.ms removed' }, 'results', results, false));
  writeFileSync(CHECK_SNAPSHOT, serializeSnapshot({ version, note: 'check() of every preset over the own results of own-v0.3.0.json', presets: names }, 'reports', reports, true));
  console.log(`wrote ${Object.keys(results).length} own results and ${Object.keys(reports).length * names.length} check reports`);
  return 0;
}

if (process.argv[1] && /own-snapshot\.ts$/.test(process.argv[1])) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.error(e instanceof Error ? (e.stack ?? e.message) : e);
      process.exitCode = 2;
    },
  );
}
