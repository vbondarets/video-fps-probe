import type { ContainerFamily } from '../plugins/types.ts';
import type { FamilyPool, Pools, WarmPools } from './probe.ts';

const FAMILIES = ['isobmff', 'matroska'] as const;

export const familyPools = (kind: string, byFamily: Readonly<Partial<Record<ContainerFamily, () => Worker>>>, pools: Pools, create?: () => Worker): readonly [FamilyPool, WarmPools] => {
  const pool: FamilyPool = (family) => {
    const own = byFamily[family];
    return own ? pools(`${kind}-${family}`, own) : pools(kind, create!);
  };
  return [pool, (containers) => FAMILIES.filter((f) => containers.includes(f)).map((f) => [pool(f), [f]])];
};
