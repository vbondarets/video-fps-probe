import type { ProbeResult } from './client/types.ts';
import type { BlobLike } from './core/reader.ts';
import type { AnalyzeOptions } from './core/types.ts';
import type { EngineDescriptor } from './plugins/types.ts';

export interface InThreadOptions extends AnalyzeOptions {
  name?: string;
  engine?: EngineDescriptor;
}

const UNCAPTURED = 'codec configuration unavailable';

export async function analyze(input: Blob | BlobLike, options: InThreadOptions = {}): Promise<ProbeResult> {
  const { name = typeof File !== 'undefined' && input instanceof File ? input.name : '', engine, ...opts } = options;
  const module = engine ? await engine.load() : (await import('./worker/runtime.ts')).ownEngine;
  const result = await module.run(input, name, opts);
  if (!opts.codecConfig || result.videoTracks.length === 0 || !result.warnings.includes(UNCAPTURED)) return result;
  try {
    const { withIsoCodecConfig } = await import('./core/isobmff/capture.ts');
    return await withIsoCodecConfig(input, result, opts.signal ?? null);
  } catch (e) {
    if (opts.signal?.aborted || (e as { name?: unknown } | null)?.name === 'AbortError') throw e;
    return { ...result, warnings: result.warnings.map((w) => (w === UNCAPTURED ? `${UNCAPTURED}: ${e instanceof Error ? e.message : String(e)}` : w)) };
  }
}
