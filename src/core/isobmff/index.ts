import type { BlobReader } from '../reader.ts';
import { emptyAnalysis } from '../result.ts';
import type { ContainerAnalysis, ResolvedAnalyzeOptions } from '../types.ts';

export async function analyzeIsoBmff(_reader: BlobReader, _opts: ResolvedAnalyzeOptions): Promise<ContainerAnalysis> {
  return emptyAnalysis('mp4', 'not implemented yet');
}
