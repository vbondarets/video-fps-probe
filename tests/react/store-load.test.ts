import { describe, expect, it, vi } from 'vitest';
import type { Probe, ProbeResult } from '../../src/client/types.ts';
import type { EngineId } from '../../src/core/types.ts';
import { createVideoFpsStore } from '../../src/react/store.ts';

vi.mock('../../src/api/summary.ts', () => {
  throw new TypeError('Failed to fetch dynamically imported module');
});

describe('the store of video-fps-probe/react when its summary module does not load', () => {
  it('gives the error state with worker-failed and reason load', async () => {
    const probe = { engines: ['own'], analyze: async () => ({}) as ProbeResult, prewarm: async () => {} } as unknown as Probe<EngineId>;
    const store = createVideoFpsStore(probe);
    const file = new Blob([new Uint8Array(8)]);
    const key = store.keyOf({});
    store.snapshot(file, key, {});
    store.subscribe(file, key, () => {});
    await vi.waitFor(() => expect(store.snapshot(file, key, {}).status).toBe('error'));
    expect(store.snapshot(file, key, {}).error).toMatchObject({ name: 'ProbeError', code: 'worker-failed', reason: 'load' });
  });
});
