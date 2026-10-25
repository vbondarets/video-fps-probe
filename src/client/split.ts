import type { ContainerFamily } from '../plugins/types.ts';
import type { FamilyPool, Lazy, Pools, Route, Runner } from './probe.ts';

const FAMILIES = ['isobmff', 'matroska'] as const;

export type SplitRoute = (kind: string, byFamily: Readonly<Partial<Record<ContainerFamily, () => Worker>>>, pools: Pools, lazy: Lazy, life: AbortSignal, create?: () => Worker) => Route;

export type HeadRunner = (pool: FamilyPool, lazy: Lazy, life: AbortSignal) => Runner;

export const splitBy =
  (runner: HeadRunner): SplitRoute =>
  (kind, byFamily, pools, lazy, life, create) => {
    const pool: FamilyPool = (family) => {
      const own = byFamily[family];
      return own ? pools(`${kind}-${family}`, own) : pools(kind, create!);
    };
    const run = runner(pool, lazy, life);
    return { kind, pool: () => run, warmPools: (containers) => FAMILIES.filter((f) => containers.includes(f)).map((f) => [pool(f), [f]]) };
  };
