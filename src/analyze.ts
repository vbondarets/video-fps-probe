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
  return module.run(input, name, opts);
}
