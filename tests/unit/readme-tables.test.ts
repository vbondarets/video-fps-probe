import { describe, expect, it } from 'vitest';
import { staleBenchChunks } from '../../scripts/readme-tables.ts';

type Inputs = Parameters<typeof staleBenchChunks>[0];

function inputs(build: Array<{ file: string; hash?: string }>, fetched: Array<{ path: string; hash?: string | null }>): Inputs {
  return {
    size: { budgets: [], composites: {}, chunks: build.map((c) => ({ kind: 'lazy', raw: 1, gzip: 1, brotli: 1, ...c })) },
    bench: { chrome: { coldFirst: [{ name: 'a.mp4', label: 'MP4', coldWallMs: 1, warmWallMs: 1, chunks: fetched.map((k) => ({ bytes: 1, ...k })) }] } },
  } as unknown as Inputs;
}

describe('readme-tables staleBenchChunks', () => {
  it('keeps a fetched chunk whose content hash is in the build, under another file name', () => {
    expect(staleBenchChunks(inputs([{ file: 'assets/isobmff-NEWNAME1.js', hash: 'aaaa' }], [{ path: '/assets/isobmff-OLDNAME1.js', hash: 'aaaa' }]))).toEqual([]);
  });

  it('marks a fetched chunk whose content hash is not in the build, even when its file name is', () => {
    expect(staleBenchChunks(inputs([{ file: 'assets/isobmff-SAMENAME.js', hash: 'bbbb' }], [{ path: '/assets/isobmff-SAMENAME.js', hash: 'aaaa' }]))).toEqual(['isobmff-SAMENAME.js']);
  });

  it('falls back to the file name for a report without hashes', () => {
    const build = [{ file: 'assets/isobmff-SAMENAME.js', hash: 'bbbb' }];
    expect(staleBenchChunks(inputs(build, [{ path: '/assets/isobmff-SAMENAME.js' }]))).toEqual([]);
    expect(staleBenchChunks(inputs(build, [{ path: '/assets/isobmff-OLDNAME1.js', hash: null }]))).toEqual(['isobmff-OLDNAME1.js']);
  });

  it('lists each stale chunk once', () => {
    const fetched = [
      { path: '/assets/main-OLDNAME1.js', hash: 'cccc' },
      { path: '/assets/main-OLDNAME1.js', hash: 'cccc' },
    ];
    expect(staleBenchChunks(inputs([{ file: 'assets/main-NEWNAME1.js', hash: 'dddd' }], fetched))).toEqual(['main-OLDNAME1.js']);
  });
});
