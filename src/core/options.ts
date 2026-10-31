import type { AnalyzeOptions, CostModel, ReadAheadSizes, ResolvedAnalyzeOptions } from './types.ts';

export const DEFAULT_READ_AHEAD: Readonly<ReadAheadSizes> = {
  head: 64 * 1024,
  fragment: 1024 * 1024,
  matroskaScan: 1024 * 1024,
  tail: 256 * 1024,
};

export const DEFAULT_COST_MODEL: Readonly<CostModel> = {
  perReadMs: 0.8,
  bytesPerMs: 500_000,
  perBlockMs: 0.0002,
};

export const DEFAULT_EXACT_BUDGET_MS = 150;
export const MAX_EXPANDED_SAMPLES = 5_000_000;

function mergeDefined<T extends object>(base: Readonly<T>, patch: Partial<T> | undefined): T {
  const out = { ...base } as T;
  if (!patch) return out;
  for (const key of Object.keys(patch) as (keyof T)[]) {
    const v = patch[key];
    if (v !== undefined) out[key] = v as T[keyof T];
  }
  return out;
}

export function resolveOptions(opts: AnalyzeOptions = {}): ResolvedAnalyzeOptions {
  return {
    ...opts,
    signal: opts.signal ?? null,
    matroskaMode: opts.matroskaMode ?? 'auto',
    exactBudgetMs: opts.exactBudgetMs ?? DEFAULT_EXACT_BUDGET_MS,
    readAhead: mergeDefined(DEFAULT_READ_AHEAD, opts.readAhead),
    costModel: mergeDefined(DEFAULT_COST_MODEL, opts.costModel),
    maxExpandedSamples: opts.maxExpandedSamples ?? MAX_EXPANDED_SAMPLES,
    onProgress: opts.onProgress ?? null,
  };
}

export function predictReadMs(model: CostModel, reads: number, bytes: number): number {
  return reads * model.perReadMs + bytes / model.bytesPerMs;
}
