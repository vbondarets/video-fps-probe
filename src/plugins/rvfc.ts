import { ProbeError } from '../api/errors.ts';
import type { RvfcRunOptions } from '../engines/rvfc.ts';
import type { EngineDescriptor } from './types.ts';

export interface RvfcPluginOptions {
  host?: HTMLElement | (() => HTMLElement);
}

export function rvfc(options: RvfcPluginOptions = {}): EngineDescriptor<'rvfc'> {
  const hostOf = () => (typeof options.host === 'function' ? options.host() : options.host);
  return {
    id: 'rvfc',
    thread: 'main',
    load: async () => {
      const m = await import('../engines/rvfc.ts');
      return {
        containers: m.containers,
        run: (blob, name, opts: RvfcRunOptions) =>
          typeof document === 'undefined'
            ? Promise.reject(new ProbeError('unsupported-environment', 'rVFC plays the file, so it needs a DOM', { engine: 'rvfc' }))
            : m.run(blob, name, { ...opts, host: opts.host ?? hostOf() }),
      };
    },
  };
}
