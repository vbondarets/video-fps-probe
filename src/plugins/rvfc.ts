import type { EngineDescriptor } from './types.ts';

export interface RvfcPluginOptions {
  host?: HTMLElement | (() => HTMLElement);
}

export function rvfc(options: RvfcPluginOptions = {}): EngineDescriptor<'rvfc'> {
  return { id: 'rvfc', thread: 'main', load: async () => (await import('../engines/rvfc.ts')).hosted(options.host) };
}
