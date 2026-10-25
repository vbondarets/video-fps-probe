import type { ContainerFamily } from '../plugins/types.ts';

export const EBML = [0x1a, 0x45, 0xdf, 0xa3] as const;

export const familyOf = (file: Blob, signal?: AbortSignal | null): Promise<ContainerFamily> =>
  new Promise((resolve) => {
    const iso = () => resolve('isobmff');
    if (signal?.aborted) return iso();
    signal?.addEventListener('abort', iso);
    Promise.resolve()
      .then(() => file.slice(0, 4).arrayBuffer())
      .then((b) => {
        const head = new Uint8Array(b);
        resolve(EBML.every((x, i) => head[i] === x) ? 'matroska' : 'isobmff');
      }, iso)
      .finally(() => signal?.removeEventListener('abort', iso));
  });
