import { describe, expect, it } from 'vitest';
import { analyze, firstReadAhead } from '../../src/core/analyze.ts';
import { resolveOptions } from '../../src/core/options.ts';
import { fixturePath, loadManifest } from '../helpers/fixtures.ts';
import { withFixture } from '../helpers/open-blob.ts';

const committed = loadManifest().filter((m) => m.committed);

async function readsOf(name: string): Promise<{ size: number; reads: number; bytesRead: number }> {
  const path = fixturePath(name);
  if (!path) throw new Error(`${name} is missing`);
  return withFixture(path, async (blob, size) => ({ size, ...(await analyze(blob, name)).io }));
}

describe('reads per committed fixture', () => {
  it('reads every committed fixture below the single-read size once, whole', async () => {
    const opts = resolveOptions();
    expect(committed.length).toBeGreaterThan(100);
    const reads: number[] = [];
    for (const { name } of committed) {
      const io = await readsOf(name);
      reads.push(io.reads);
      if (io.size === 0) expect(io.reads, name).toBe(0);
      else if (firstReadAhead(io.size, opts) === io.size) expect({ name, reads: io.reads, bytesRead: io.bytesRead }).toEqual({ name, reads: 1, bytesRead: io.size });
    }
    const sorted = [...reads].sort((a, b) => a - b);
    expect(sorted[sorted.length >> 1]).toBe(1);
  });
});
