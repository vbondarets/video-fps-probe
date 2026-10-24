import { describe, expect, it } from 'vitest';
import { analyze, firstReadAhead, type AnalyzerRegistry } from '../../src/core/analyze.ts';
import { resolveOptions } from '../../src/core/options.ts';
import { emptyAnalysis, emptyTrack } from '../../src/core/result.ts';
import type { ContainerAnalyzer } from '../../src/core/types.ts';

function ftypBlob(totalSize = 4096): Blob {
  const b = new Uint8Array(totalSize);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, 24);
  b.set([0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d], 4);
  return new Blob([b]);
}

function ebmlBlob(): Blob {
  return new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0, 0, 0])]);
}

const stubIso: ContainerAnalyzer = async (reader, opts) => {
  await reader.view(0, 8);
  const a = emptyAnalysis('mov');
  a.brand = 'qt  ';
  a.videoTracks = [{ ...emptyTrack(1), timescale: opts.readAhead.head }];
  a.primaryTrackId = 1;
  return a;
};

const failing: ContainerAnalyzer = async () => {
  throw new Error('incomplete file: no moov');
};

const registry = (iso: ContainerAnalyzer, mkv: ContainerAnalyzer = failing): AnalyzerRegistry => ({ isobmff: iso, matroska: mkv });

describe('first read', () => {
  it('reads the whole file when one read costs less than two by the cost model', () => {
    const opts = resolveOptions();
    const limit = opts.readAhead.head + opts.costModel.perReadMs * opts.costModel.bytesPerMs;
    expect(limit).toBe(465_536);
    expect(firstReadAhead(1000, opts)).toBe(1000);
    expect(firstReadAhead(limit - 1, opts)).toBe(limit - 1);
    expect(firstReadAhead(limit, opts)).toBe(65_536);
    expect(firstReadAhead(600_000_000, opts)).toBe(65_536);
  });

  it('follows the head window and the cost model options', () => {
    expect(firstReadAhead(200_000, resolveOptions({ costModel: { perReadMs: 0 } }))).toBe(65_536);
    expect(firstReadAhead(60_000, resolveOptions({ costModel: { perReadMs: 0 } }))).toBe(60_000);
    expect(firstReadAhead(500_000, resolveOptions({ readAhead: { head: 200_000 } }))).toBe(500_000);
    expect(firstReadAhead(500_000, resolveOptions({ costModel: { bytesPerMs: 100_000 } }))).toBe(65_536);
  });
});

describe('analyze', () => {
  it('leaves the parser chunk load out of io.ms, as the library engines do', async () => {
    const slowLoad = async (): Promise<ContainerAnalyzer> => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return stubIso;
    };
    const t0 = performance.now();
    const r = await analyze(ftypBlob(), 'clip.mp4', {}, registry(failing), { isobmff: slowLoad, matroska: slowLoad });
    expect(performance.now() - t0).toBeGreaterThanOrEqual(100);
    expect(r.error).toBeNull();
    expect(r.container).toBe('mov');
    expect(r.io.ms).toBeLessThan(100);
  });

  it('dispatches ISO BMFF by content and fills io stats', async () => {
    const r = await analyze(ftypBlob(), 'clip.webm', {}, registry(stubIso));
    expect(r.name).toBe('clip.webm');
    expect(r.size).toBe(4096);
    expect(r.engine).toBe('own');
    expect(r.container).toBe('mov');
    expect(r.brand).toBe('qt  ');
    expect(r.primaryTrackId).toBe(1);
    expect(r.videoTracks[0].timescale).toBe(65536);
    expect(r.error).toBeNull();
    expect(r.io.reads).toBe(1);
    expect(r.io.bytesRead).toBe(4096);
    expect(r.io.ms).toBeGreaterThanOrEqual(0);
  });

  it('dispatches Matroska by the EBML magic and turns parser errors into results', async () => {
    const r = await analyze(ebmlBlob(), 'clip.mp4', {}, registry(stubIso, failing));
    expect(r.container).toBe('matroska');
    expect(r.error).toBe('incomplete file: no moov');
    expect(r.io.reads).toBe(1);
  });

  it('keeps the sniffed container when the parser throws', async () => {
    const r = await analyze(ftypBlob(), 'x.mp4', {}, registry(failing));
    expect(r.container).toBe('mp4');
    expect(r.error).toBe('incomplete file: no moov');
  });

  it('reports unrecognised and empty files without throwing', async () => {
    const png = await analyze(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])]), 'a.mp4');
    expect(png.container).toBe('unknown');
    expect(png.error).toBe('not a recognised container: PNG image');
    const empty = await analyze(new Blob([]), 'empty.mp4');
    expect(empty.error).toBe('not a recognised container: empty file');
    expect(empty.io.reads).toBe(0);
  });

  it('passes read-ahead options to the reader', async () => {
    const r = await analyze(ftypBlob(1 << 20), 'x.mov', { readAhead: { head: 4096 } }, registry(stubIso));
    expect(r.io.bytesRead).toBe(4096);
    expect(r.videoTracks[0].timescale).toBe(4096);
  });

  it('rethrows AbortError instead of returning a result', async () => {
    const ctl = new AbortController();
    const slow: ContainerAnalyzer = async (reader) => {
      ctl.abort();
      await reader.view(100_000, 8);
      return emptyAnalysis('mp4');
    };
    await expect(analyze(ftypBlob(1 << 20), 'x.mp4', { signal: ctl.signal }, registry(slow))).rejects.toMatchObject({
      name: 'AbortError',
    });
    const pre = new AbortController();
    pre.abort();
    await expect(analyze(ftypBlob(), 'x.mp4', { signal: pre.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('runs the default parsers without throwing', async () => {
    const iso = await analyze(ftypBlob(), 'x.mp4');
    expect(iso.container === 'mp4' || iso.container === 'mov').toBe(true);
    expect(typeof iso.error === 'string' || iso.error === null).toBe(true);
    const mkv = await analyze(ebmlBlob(), 'x.mkv');
    expect(mkv.container === 'matroska' || mkv.container === 'webm').toBe(true);
  });
});
