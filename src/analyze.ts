import type { ProbeResult } from './client/types.ts';
import type { BlobLike } from './core/reader.ts';
import type { AnalyzeOptions } from './core/types.ts';
import type { EngineDescriptor } from './plugins/types.ts';

export interface InThreadOptions extends AnalyzeOptions {
  name?: string;
  engine?: EngineDescriptor;
}

export async function analyze(input: Blob | BlobLike, options: InThreadOptions = {}): Promise<ProbeResult> {
  const { name = typeof File !== 'undefined' && input instanceof File ? input.name : '', engine, ...opts } = options;
  const module = engine ? await engine.load() : (await import('./worker/runtime.ts')).ownEngine;
  const result = await module.run(input, name, opts);
  if (!result.videoTracks.some((t) => t.codecConfig?.family === 'isobmff-moov')) return result;
  try {
    const { isoBoxes } = await import('./core/isobmff/config.ts');
    return { ...result, videoTracks: result.videoTracks.map((t) => (t.codecConfig?.family === 'isobmff-moov' ? { ...t, codecConfig: isoBoxes(t.codecConfig.moov, t.codecConfig.trak) } : t)) };
  } catch {
    return result;
  }
}
