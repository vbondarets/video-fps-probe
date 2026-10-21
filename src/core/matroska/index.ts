import type { BlobReader } from '../reader.ts';
import { emptyAnalysis } from '../result.ts';
import type { ContainerAnalysis, ResolvedAnalyzeOptions } from '../types.ts';

export async function analyzeMatroska(_reader: BlobReader, _opts: ResolvedAnalyzeOptions): Promise<ContainerAnalysis> {
  return emptyAnalysis('matroska', 'not implemented yet');
}
