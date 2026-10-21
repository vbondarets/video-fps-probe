import { describe, expect, it } from 'vitest';
import { planExactScan } from '../../src/core/matroska/index.ts';
import { DEFAULT_COST_MODEL, predictReadMs, resolveOptions } from '../../src/core/options.ts';

describe('cost model', () => {
  it('ships a per-block CPU term next to the I/O terms', () => {
    expect(DEFAULT_COST_MODEL).toEqual({ perReadMs: 0.8, bytesPerMs: 500_000, perBlockMs: 0.0002 });
    expect(resolveOptions().costModel).toEqual(DEFAULT_COST_MODEL);
  });

  it('merges partial overrides over the defaults and skips undefined fields', () => {
    expect(resolveOptions({ costModel: { perBlockMs: 0.001 } }).costModel).toEqual({ ...DEFAULT_COST_MODEL, perBlockMs: 0.001 });
    expect(resolveOptions({ costModel: { perReadMs: undefined, perBlockMs: 0 } }).costModel).toEqual({ ...DEFAULT_COST_MODEL, perBlockMs: 0 });
  });

  it('predicts read time from reads and bytes only', () => {
    expect(predictReadMs({ perReadMs: 2, bytesPerMs: 1000, perBlockMs: 5 }, 3, 4000)).toBe(10);
  });

  it('prices Matroska scan plans with the per-block term from the cost model', () => {
    const region = 14_457_930;
    const estimate = { blocks: 648_000, large: 0, smallBytes: region };
    const free = planExactScan(region, estimate, resolveOptions({ costModel: { perBlockMs: 0 } }));
    const standard = planExactScan(region, estimate, resolveOptions());
    const slow = planExactScan(region, estimate, resolveOptions({ costModel: { perBlockMs: 0.001 } }));
    expect(standard.ms - free.ms).toBeCloseTo(648_000 * DEFAULT_COST_MODEL.perBlockMs, 6);
    expect(slow.ms - free.ms).toBeCloseTo(648_000 * 0.001, 6);
    expect(free.window).toBe(standard.window);
    expect(free.ms).toBeLessThan(resolveOptions().exactBudgetMs);
    expect(standard.ms).toBeGreaterThan(resolveOptions().exactBudgetMs);
  });

  it('adds nothing for blocks when there is no estimate', () => {
    const region = 5 * 1024 * 1024;
    const heavy = resolveOptions({ costModel: { perBlockMs: 10 } });
    expect(planExactScan(region, null, heavy).ms).toBeCloseTo(planExactScan(region, null, resolveOptions()).ms, 9);
  });
});
