import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isValidDeviationKey, type FixtureDeviations } from './types.ts';

export const MIN_REASON_LENGTH = 15;

export interface LoadedDeviations {
  byFixture: Map<string, Record<string, string>>;
  files: string[];
  problems: string[];
}

export function deviationFilesFor(dir: string, engine: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && (f === `${engine}.json` || f.startsWith(`${engine}-`)))
    .sort();
}

export function parseDeviations(
  fileName: string,
  text: string,
  into: Map<string, Record<string, string>>,
  problems: string[],
): void {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    problems.push(`${fileName}: invalid JSON (${e instanceof Error ? e.message : String(e)})`);
    return;
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    problems.push(`${fileName}: top level must be an object { "<fixture>": { "<field>": "<reason>" } }`);
    return;
  }
  for (const [fixture, fields] of Object.entries(json)) {
    if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) {
      problems.push(`${fileName}: "${fixture}" must map field names to reason strings`);
      continue;
    }
    for (const [key, reason] of Object.entries(fields)) {
      if (!isValidDeviationKey(key)) {
        problems.push(`${fileName}: "${fixture}" has unknown field "${key}"`);
        continue;
      }
      if (typeof reason !== 'string' || reason.trim().length < MIN_REASON_LENGTH) {
        problems.push(`${fileName}: "${fixture}.${key}" needs a concrete reason of at least ${MIN_REASON_LENGTH} characters`);
        continue;
      }
      const entry = into.get(fixture) ?? {};
      if (key in entry) problems.push(`${fileName}: "${fixture}.${key}" is defined twice, the later file wins`);
      entry[key] = reason.trim();
      into.set(fixture, entry);
    }
  }
}

export function loadDeviations(dir: string, engine: string): LoadedDeviations {
  const byFixture = new Map<string, Record<string, string>>();
  const problems: string[] = [];
  const files = deviationFilesFor(dir, engine);
  for (const f of files) parseDeviations(f, readFileSync(join(dir, f), 'utf8'), byFixture, problems);
  return { byFixture, files, problems };
}

export function forFixture(loaded: LoadedDeviations | null, name: string): FixtureDeviations | null {
  return loaded?.byFixture.get(name) ?? null;
}
