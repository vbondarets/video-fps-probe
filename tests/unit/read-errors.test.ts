import { openAsBlob } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/core/analyze.ts';
import type { BlobLike } from '../../src/core/reader.ts';
import { FILES_DIR } from '../helpers/fixtures.ts';

type Failure = (start: number, end: number) => Promise<ArrayBuffer> | null;

async function failing(name: string, fail: Failure): Promise<BlobLike> {
  const blob = await openAsBlob(join(FILES_DIR, name));
  return {
    size: blob.size,
    slice: (start = 0, end = blob.size) => ({ arrayBuffer: () => fail(start, end) ?? blob.slice(start, end).arrayBuffer() }),
  };
}

const laterRead = (error: unknown): Failure => (start) => (start > 0 ? Promise.reject(error) : null);
const SPLIT = { costModel: { perReadMs: 0 } };

describe('a file that cannot be read', () => {
  it.each(['cfr_h264_30.mp4', 'cfr_vp9_30.webm'])('%s: a NotReadableError or InvalidStateError is a read failure, not a corrupt file', async (name) => {
    for (const error of [new DOMException('The requested file could not be read', 'NotReadableError'), new DOMException('An operation that depends on state cached in an interface object was made', 'InvalidStateError')]) {
      const r = await analyze(await failing(name, laterRead(error)), name, SPLIT);
      expect(r.error).toBe(`file read failed: ${error.name}: ${error.message}`);
      expect(r.videoTracks).toEqual([]);
    }
  });

  it('is a read failure on the first read too, and for a read that throws instead of rejecting', async () => {
    const first = await analyze(await failing('cfr_h264_30.mp4', () => Promise.reject(new DOMException('gone', 'NotFoundError'))), 'first.mp4');
    expect(first.error).toBe('file read failed: NotFoundError: gone');
    const thrown = await analyze(
      await failing('cfr_h264_30.mp4', (start) => {
        if (start > 0) throw new TypeError('detached');
        return null;
      }),
      'thrown.mp4',
      SPLIT,
    );
    expect(thrown.error).toBe('file read failed: TypeError: detached');
    const bare = await analyze(await failing('cfr_vp9_30.webm', laterRead('no reason')), 'bare.webm', SPLIT);
    expect(bare.error).toBe('file read failed: no reason');
  });

  it('is a read failure when the file got shorter after it was picked', async () => {
    const r = await analyze(await failing('cfr_h264_30.mp4', (start, end) => (start > 0 ? Promise.resolve(new ArrayBuffer(Math.max(0, end - start - 100))) : null)), 'short.mp4', SPLIT);
    expect(r.error).toMatch(/^file read failed: short read at \d+: expected \d+ bytes, got \d+$/);
  });

  it('still rejects for an abort from the source', async () => {
    const abort = new DOMException('stop', 'AbortError');
    await expect(analyze(await failing('cfr_h264_30.mp4', laterRead(abort)), 'abort.mp4', SPLIT)).rejects.toBe(abort);
  });
});
