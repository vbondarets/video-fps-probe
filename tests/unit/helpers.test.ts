import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BlobReader } from '../../src/core/reader.ts';
import { MANIFEST_PATH, REPO_ROOT, loadManifest, parseManifest, refOptionalNumber } from '../helpers/fixtures.ts';
import { openFixture } from '../helpers/open-blob.ts';
import { existsSync } from 'node:fs';

const SAMPLE = join(REPO_ROOT, 'package.json');

describe('openFixture', () => {
  it('returns identical bytes through openAsBlob and FileSlice', async () => {
    const a = await openFixture(SAMPLE);
    const b = await openFixture(SAMPLE, { forceFileSlice: true });
    try {
      expect(a.kind).toBe('openAsBlob');
      expect(b.kind).toBe('fileSlice');
      expect(b.size).toBe(a.size);
      const ra = new BlobReader(a.blob);
      const rb = new BlobReader(b.blob);
      for (const [o, n] of [
        [0, 16],
        [5, 100],
        [a.size - 10, 10],
        [a.size - 3, 50],
      ] as const) {
        expect(Array.from(await rb.read(o, n))).toEqual(Array.from(await ra.read(o, n)));
      }
      expect((await b.blob.slice(-4).arrayBuffer()).byteLength).toBe(4);
      expect((await b.blob.slice(10, 5).arrayBuffer()).byteLength).toBe(0);
    } finally {
      await a.close();
      await b.close();
    }
  });
});

describe('fixture manifest', () => {
  it('parses a headed manifest with the six columns', () => {
    const text = [
      'name\tcontainer\tcategory\texpect\tcommitted\tnotes',
      'cfr_h264_30.mp4\tmp4\tcfr\tavg=30/1\tyes\tCFR 30 fps',
      'long_cfr_3h_60fps.mp4\tmp4\tlong\tavg=60/1\tno\tgenerated with --with-long',
      '',
      '# comment',
    ].join('\n');
    const m = parseManifest(text);
    expect(m).toHaveLength(2);
    expect(m[0]).toMatchObject({ name: 'cfr_h264_30.mp4', container: 'mp4', category: 'cfr', expect: 'avg=30/1', committed: true, notes: 'CFR 30 fps' });
    expect(m[1].committed).toBe(false);
  });

  it('parses headerless rows positionally and the legacy name/notes form', () => {
    const m = parseManifest('a.webm\twebm\tvfr\t-\t1\tsome notes\r\nb.mp4\tlegacy notes\n');
    expect(m[0]).toMatchObject({ name: 'a.webm', container: 'webm', category: 'vfr', committed: true, notes: 'some notes' });
    expect(m[1]).toMatchObject({ name: 'b.mp4', container: '', notes: 'legacy notes', committed: false });
  });

  it.skipIf(!existsSync(MANIFEST_PATH))('loads fixtures/manifest.tsv when it exists', () => {
    const m = loadManifest();
    expect(m.length).toBeGreaterThan(0);
    for (const e of m) expect(e.name).not.toBe('');
  });

  it('maps ffprobe N/A to null', () => {
    expect(refOptionalNumber('N/A')).toBeNull();
    expect(refOptionalNumber(null)).toBeNull();
    expect(refOptionalNumber('90')).toBe(90);
    expect(refOptionalNumber(3.5)).toBe(3.5);
  });
});
