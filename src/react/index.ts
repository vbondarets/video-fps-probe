'use client';
import { createContext, createElement, useCallback, useContext, useMemo, useSyncExternalStore, type ReactElement, type ReactNode } from 'react';
import { ProbeError } from '../api/errors.ts';
import type { PrewarmOptions, Probe } from '../client/types.ts';
import type { EngineId } from '../core/types.ts';
import { createVideoFpsStore, type UseVideoFpsOptions, type VideoFpsState, type VideoFpsStore } from './store.ts';

export type { VideoFpsSummary } from '../api/summary.ts';
export type { UseVideoFpsOptions, VideoFpsState };

export interface VideoFpsProviderProps {
  probe: Probe<EngineId>;
  children?: ReactNode;
}

const StoreContext = createContext<VideoFpsStore | null>(null);

export function VideoFpsProvider({ probe, children }: VideoFpsProviderProps): ReactElement {
  const store = useMemo(() => createVideoFpsStore(probe), [probe]);
  return createElement(StoreContext.Provider, { value: store }, children);
}

function useStore(): VideoFpsStore {
  const store = useContext(StoreContext);
  if (!store) throw new ProbeError('engine-not-registered', 'wrap in VideoFpsProvider');
  return store;
}

export function useVideoFps(file: Blob | null | undefined, options: UseVideoFpsOptions = {}): VideoFpsState {
  const store = useStore();
  const key = file && options.enabled !== false ? store.keyOf(options) : null;
  const subscribe = useCallback((listener: () => void) => (file && key !== null ? store.subscribe(file, key, listener) : () => {}), [store, file, key]);
  const snapshot = (): VideoFpsState => store.snapshot(file, key, options);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function useVideoFpsProbe<P extends Probe<EngineId> = Probe<EngineId>>(): P {
  return useStore().probe as P;
}

export function usePrewarmVideoFps(options?: PrewarmOptions<EngineId>): () => void {
  const store = useStore();
  const key = JSON.stringify(options ?? null);
  return useCallback(() => store.prewarm(JSON.parse(key) ?? undefined), [store, key]);
}
