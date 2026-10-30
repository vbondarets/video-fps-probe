import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { check } from '../../src/check/index.ts';
import type { FileResult } from '../../src/core/types.ts';
import { CHECK_SNAPSHOT, OWN_SNAPSHOT, checkReportsOf, ownResultOf, presetEntries, type CheckSnapshot, type OwnSnapshot } from '../../scripts/own-snapshot.ts';
import { fixturePath } from '../helpers/fixtures.ts';

const ALLOWED_NEW_WARNINGS: readonly RegExp[] = [];

const own = JSON.parse(readFileSync(OWN_SNAPSHOT, 'utf8')) as OwnSnapshot;
const checks = JSON.parse(readFileSync(CHECK_SNAPSHOT, 'utf8')) as CheckSnapshot;
const names = Object.keys(own.results);

function keptWarnings(list: unknown): unknown {
  return Array.isArray(list) ? list.filter((w) => !(typeof w === 'string' && ALLOWED_NEW_WARNINGS.some((r) => r.test(w)))) : list;
}

function differences(was: unknown, now: unknown, path: string, out: string[] = []): string[] {
  if (Array.isArray(was)) {
    const list = path.endsWith('.warnings') ? keptWarnings(now) : now;
    if (!Array.isArray(list) || list.length !== was.length) {
      out.push(`${path}: ${JSON.stringify(was)} at 0.3.0, now ${JSON.stringify(now)}`);
      return out;
    }
    was.forEach((v, i) => differences(v, list[i], `${path}[${i}]`, out));
    return out;
  }
  if (was !== null && typeof was === 'object') {
    if (now === null || typeof now !== 'object' || Array.isArray(now)) {
      out.push(`${path}: an object at 0.3.0, now ${JSON.stringify(now)}`);
      return out;
    }
    for (const [k, v] of Object.entries(was)) {
      if (!(k in now)) out.push(`${path}.${k}: ${JSON.stringify(v)} at 0.3.0, now absent`);
      else differences(v, (now as Record<string, unknown>)[k], `${path}.${k}`, out);
    }
    return out;
  }
  if (!Object.is(was, now)) out.push(`${path}: ${JSON.stringify(was)} at 0.3.0, now ${JSON.stringify(now)}`);
  return out;
}

describe('own results and preset verdicts against the 0.3.0 snapshot', () => {
  test('the snapshot holds every committed 0.3.0 fixture and every preset', () => {
    expect(own.version).toBe('0.3.0');
    expect(names.length).toBe(158);
    for (const name of names) expect(fixturePath(name), name).not.toBeNull();
    expect(Object.keys(checks.reports)).toEqual(names);
    expect(checks.presets).toEqual(presetEntries().map(([n]) => n));
  });

  test('the comparison reports a changed, a missing and a new value as intended', () => {
    const was = { a: 1, b: { c: [1, 2] }, warnings: ['x'] };
    expect(differences(was, { a: 1, b: { c: [1, 2] }, warnings: ['x'], added: true }, 'r')).toEqual([]);
    expect(differences(was, { a: 2, b: { c: [1] }, warnings: ['x', 'y'] }, 'r')).toEqual(['r.a: 1 at 0.3.0, now 2', 'r.b.c: [1,2] at 0.3.0, now [1]', 'r.warnings: ["x"] at 0.3.0, now ["x","y"]']);
    expect(differences(was, { b: { c: [1, 2] }, warnings: ['x'] }, 'r')).toEqual(['r.a: 1 at 0.3.0, now absent']);
  });

  test.each(names)('%s', async (name) => {
    const was = own.results[name] as FileResult;
    const now = await ownResultOf(name);
    expect(differences(was, now, name)).toEqual([]);
    expect(checkReportsOf(now)).toEqual(checks.reports[name]);
    for (const [preset, p] of presetEntries()) expect(JSON.parse(JSON.stringify(check(was, p.rules))), preset).toEqual(checks.reports[name][preset]);
  });
});
