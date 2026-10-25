import type { ContainerFamily } from '../plugins/types.ts';
import type { Lazy, Pools, Route, Runner } from './probe.ts';

export const EBML = [0x1a, 0x45, 0xdf, 0xa3] as const;

const FAMILIES = ['isobmff', 'matroska'] as const;

export type SplitRoute = (kind: string, byFamily: Readonly<Partial<Record<ContainerFamily, () => Worker>>>, pools: Pools, lazy: Lazy, life: AbortSignal, create?: () => Worker) => Route;

export const familyOf = (file: Blob, signal?: AbortSignal | null): Promise<ContainerFamily> =>
  new Promise((resolve) => {
    const iso = () => resolve('isobmff');
    if (signal?.aborted) return iso();
    signal?.addEventListener('abort', iso);
    Promise.resolve()
      .then(() => file.slice(0, 4).arrayBuffer())
      .then((b): ContainerFamily => {
        const head = new Uint8Array(b);
        return EBML.every((x, i) => head[i] === x) ? 'matroska' : 'isobmff';
      })
      .then(resolve, iso)
      .finally(() => signal?.removeEventListener('abort', iso));
  });

export const splitRoute: SplitRoute = (kind, byFamily, pools, lazy, life, create) => {
  const pool = (family: ContainerFamily) => {
    const own = byFamily[family];
    return own ? pools(`${kind}-${family}`, own) : pools(kind, create!);
  };
  const runner: Runner = {
    run: (request, options = {}) =>
      request.type === 'warm'
        ? Promise.allSettled(FAMILIES.filter((f) => request.containers.includes(f)).map((f) => pool(f).run({ ...request, containers: [f] }, options)))
        : lazy(familyOf(request.file, options.signal), request.engine).then((family) => (life.aborted ? lazy(Promise.reject(), request.engine) : pool(family).run(request, options))),
  };
  return { kind, pool: () => runner };
};
