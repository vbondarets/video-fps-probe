import type { ProbeResult } from './client/types.ts';
import type { AnalyzerLoaders } from './core/analyze.ts';
import type { BlobLike } from './core/reader.ts';
import type { AnalyzeOptions } from './core/types.ts';
import type { EngineDescriptor } from './plugins/types.ts';

export interface InThreadOptions extends AnalyzeOptions {
  name?: string;
  engine?: EngineDescriptor;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message || e.name : String(e));

const capturingIsoBmff: AnalyzerLoaders['isobmff'] = async () => {
  const [{ analyzeIsoBmffDetailed }, { isVideoTrack }, capture] = await Promise.all([
    import('./core/isobmff/index.ts'),
    import('./core/isobmff/build.ts'),
    import('./core/isobmff/config.ts').then(
      (m) => m.isoCodecConfig,
      (e: unknown) => new Error(messageOf(e)),
    ),
    import('./core/stats.ts'),
  ]);
  return async (reader, opts) => {
    const { analysis, movie } = await analyzeIsoBmffDetailed(reader, { ...opts, codecConfig: false });
    if (analysis.videoTracks.length === 0) return analysis;
    try {
      if (capture instanceof Error) throw capture;
      const configs = movie.tracks.filter((t) => isVideoTrack(t, movie)).map((t) => capture(movie, t));
      analysis.videoTracks.forEach((t, i) => (t.codecConfig = configs[i]));
    } catch (e) {
      analysis.warnings.push(`codec configuration unavailable: ${messageOf(e)}`);
    }
    return analysis;
  };
};

export async function analyze(input: Blob | BlobLike, options: InThreadOptions = {}): Promise<ProbeResult> {
  const { name = typeof File !== 'undefined' && input instanceof File ? input.name : '', engine, ...opts } = options;
  if (engine) return (await engine.load()).run(input, name, opts);
  if (!opts.codecConfig) return (await import('./worker/runtime.ts')).ownEngine.run(input, name, opts);
  const core = await import('./core/analyze.ts');
  return core.analyze(input, name, opts, core.DEFAULT_ANALYZERS, { ...core.DEFAULT_LOADERS, isobmff: capturingIsoBmff });
}
