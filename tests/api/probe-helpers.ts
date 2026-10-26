import type { EngineId, FileResult } from '../../src/core/types.ts';
import type { EngineDescriptor, EngineModule } from '../../src/plugins/types.ts';
import { fakeResult, FakeWorker } from './fake-worker.ts';

export const mp4File = (name = 'a.mp4') => new File([new Uint8Array([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0, 0, 0, 0, 0])], name);

export const webmFile = (name = 'a.webm') => new File([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0])], name);

export interface FakeModule extends EngineModule {
  calls: { name: string; opts: Record<string, unknown> }[];
}

export function fakeModule(engine: EngineId, result: (name: string) => FileResult = (name) => fakeResult(name, engine), containers: EngineModule['containers'] = 'any'): FakeModule {
  const calls: FakeModule['calls'] = [];
  return {
    calls,
    containers,
    run: async (_blob, name, opts) => {
      calls.push({ name, opts: opts as Record<string, unknown> });
      return result(name);
    },
    warm: async () => {},
  };
}

export function workerDescriptor<Id extends EngineId>(id: Id, module: EngineModule = fakeModule(id), own: EngineModule | null = fakeModule('own')): EngineDescriptor<Id> {
  return { id, thread: 'worker', createWorker: FakeWorker.as(id), load: async () => module, ...(own && { loadOwn: async () => own }) };
}

export function mainDescriptor<Id extends EngineId>(id: Id, module: EngineModule = fakeModule(id)): EngineDescriptor<Id> {
  return { id, thread: 'main', load: async () => module };
}

export const foreignProbeError = (code: string, message: string, engine: string | null = null): Error & { code: string; engine: string | null } =>
  Object.assign(new (class ProbeError extends Error {})(message), { name: 'ProbeError', code, engine });

export const customWorker = <W extends 'own' | 'mp4box' | 'mediabunny'>(...engines: W[]) => ({ create: FakeWorker.as('custom'), engines });

export const analyzed = (w: FakeWorker) => w.posted.filter((m) => m.type === 'analyze');
