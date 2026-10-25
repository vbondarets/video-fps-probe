import type { ContainerFamily } from '../plugins/types.ts';
import { splitBy, type HeadRunner } from './split.ts';

export const EBML = [0x1a, 0x45, 0xdf, 0xa3] as const;

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

export const runByHead: HeadRunner = (pool, lazy, life) => ({
  run: (request, options) => lazy(familyOf(request.file, options.signal), request.engine).then((family) => (life.aborted ? lazy(Promise.reject(), request.engine) : pool(family).run(request, options))),
});

export const splitRoute = splitBy(runByHead);
