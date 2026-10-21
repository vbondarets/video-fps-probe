import { expect } from 'vitest';
import type { EngineId, FileResult, Provenance } from '../../src/core/types.ts';
import type { FieldDiff } from './deviation.ts';

const PROVENANCE: readonly Provenance[] = ['header', 'exact', 'sampled', 'estimated', 'computed'];

export function expectContract(r: FileResult, engine: EngineId, name: string, size: number, options: { noReads?: boolean } = {}): void {
  expect(r.engine).toBe(engine);
  expect(r.name).toBe(name);
  expect(r.size).toBe(size);
  expect(Number.isInteger(r.io.reads)).toBe(true);
  expect(r.io.reads).toBeGreaterThanOrEqual(0);
  expect(r.io.bytesRead).toBeGreaterThanOrEqual(0);
  expect(r.io.bytesRead).toBeLessThanOrEqual(size);
  expect(r.io.ms).toBeGreaterThanOrEqual(0);
  if (size === 0 || options.noReads) expect(r.io.reads).toBe(0);
  else expect(r.io.reads).toBeGreaterThan(0);
  if (r.io.reads > 0) expect(r.io.bytesRead).toBeGreaterThan(0);
  expect(r.error === null || (typeof r.error === 'string' && r.error.length > 0)).toBe(true);
  expect(Array.isArray(r.warnings)).toBe(true);
  expect(r.warnings.every((w) => typeof w === 'string')).toBe(true);
  expect(Array.isArray(r.videoTracks)).toBe(true);
  if (r.primaryTrackId !== null) expect(r.videoTracks.map((t) => t.trackId)).toContain(r.primaryTrackId);
  if (r.error !== null) expect(r.videoTracks).toEqual([]);
  for (const t of r.videoTracks) {
    expect(Number.isInteger(t.trackId)).toBe(true);
    expect(Array.isArray(t.warnings)).toBe(true);
    for (const p of Object.values(t.provenance)) expect(PROVENANCE).toContain(p);
    for (const rate of [t.avgFps, t.minFps, t.maxFps]) {
      if (rate) {
        expect(Number.isFinite(rate.value)).toBe(true);
        expect(rate.value).toBeGreaterThan(0);
      }
    }
    if (t.minFps && t.maxFps) expect(t.minFps.value).toBeLessThanOrEqual(t.maxFps.value);
  }
}

export function expectExact(diffs: readonly FieldDiff[], fields: readonly string[]): void {
  const wrong = diffs.filter((d) => fields.includes(d.field) && d.verdict !== 'exact');
  expect(wrong.map((d) => `${d.field}: ${String(d.actual)} vs ffprobe ${String(d.expected)}`)).toEqual([]);
}
