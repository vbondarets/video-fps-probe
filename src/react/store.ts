import { ProbeError } from '../api/errors.ts';
import type { VideoFpsSummary } from '../api/summary.ts';
import type { CallOptions, PrewarmOptions, Probe, ProbeResult } from '../client/types.ts';
import type { AnalyzeProgress, EngineId } from '../core/types.ts';

export interface UseVideoFpsOptions extends Omit<CallOptions<EngineId>, 'signal' | 'onProgress'> {
  enabled?: boolean;
  progress?: boolean;
}

export interface VideoFpsState {
  status: 'idle' | 'pending' | 'success' | 'error';
  result: ProbeResult | null;
  summary: VideoFpsSummary | null;
  error: ProbeError | null;
  progress: AnalyzeProgress | null;
  cancel(): void;
  retry(): void;
}

export interface VideoFpsStore {
  readonly probe: Probe<EngineId>;
  keyOf(options: UseVideoFpsOptions): string;
  snapshot(file: Blob | null | undefined, key: string | null, options: UseVideoFpsOptions): VideoFpsState;
  subscribe(file: Blob, key: string, listener: () => void): () => void;
  prewarm(options?: PrewarmOptions<EngineId>): void;
}

interface Entry {
  full: VideoFpsState;
  lean: VideoFpsState;
  options: UseVideoFpsOptions;
  listeners: Set<() => void>;
  run: AbortController | null;
}

const noop = (): void => {};
const CLEAR = { result: null, summary: null, error: null, progress: null };
const IDLE: VideoFpsState = { status: 'idle', ...CLEAR, cancel: noop, retry: noop };
const hosts = new WeakMap<object, number>();
let hostCount = 0;
const loadSummary = () => import('../api/summary.ts');
const failure = (error: unknown, reason: 'load' | 'crash'): ProbeError =>
  (error as ProbeError | null)?.name === 'ProbeError' ? (error as ProbeError) : Object.assign(new ProbeError('worker-failed', String(error), { cause: error }), { reason });
const sortKeys = (_key: string, v: unknown): unknown => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v);

export function createVideoFpsStore(probe: Probe<EngineId>): VideoFpsStore {
  const cache = new WeakMap<Blob, Map<string, Entry>>();

  const set = (e: Entry, patch: Partial<VideoFpsState>, progressOnly?: boolean): void => {
    e.full = { ...e.full, ...patch };
    if (!progressOnly) e.lean = { ...e.full, progress: null };
    for (const listener of [...e.listeners]) listener();
  };

  const start = (file: Blob, e: Entry): void => {
    e.run?.abort();
    const run = (e.run = new AbortController());
    const settle = (patch: Partial<VideoFpsState>): void => {
      if (e.run !== run) return;
      e.run = null;
      set(e, patch);
    };
    if (e.full.status !== 'pending' || e.full.progress) set(e, { ...CLEAR, status: 'pending' });
    const { enabled: _enabled, progress: _progress, ...options } = e.options;
    const onProgress = (progress: AnalyzeProgress): void => {
      if (e.run === run) set(e, { progress }, true);
    };
    Promise.all([
      new Promise<ProbeResult>((done) => done(probe.analyze(file, { ...options, signal: run.signal, onProgress }))),
      loadSummary().catch((error: unknown) => {
        throw failure(error, 'load');
      }),
    ])
      .then(([result, { summarize }]) => settle({ status: 'success', result, summary: summarize(result), progress: null }))
      .catch((error: unknown) => settle({ status: 'error', error: failure(error, 'crash') }));
  };

  return {
    probe,
    keyOf({ enabled: _enabled, progress: _progress, host, ...options }) {
      if (host && !hosts.has(host)) hosts.set(host, hostCount++);
      return JSON.stringify(options, sortKeys) + (host ? ` host ${hosts.get(host)}` : '');
    },
    snapshot(file, key, options) {
      if (!file || key === null) return IDLE;
      let byKey = cache.get(file);
      if (!byKey) cache.set(file, (byKey = new Map()));
      let e = byKey.get(key);
      if (!e) {
        const entry: Entry = (e = { full: IDLE, lean: IDLE, options, listeners: new Set(), run: null });
        const cancel = (): void => {
          const run = entry.run;
          if (!run) return;
          entry.run = null;
          run.abort();
          set(entry, { status: 'error', error: new ProbeError('aborted', 'cancelled'), progress: null });
        };
        entry.full = entry.lean = { ...IDLE, status: 'pending', cancel, retry: () => start(file, entry) };
        byKey.set(key, entry);
      }
      return options.progress ? e.full : e.lean;
    },
    subscribe(file, key, listener) {
      const e = cache.get(file)?.get(key);
      if (!e) return noop;
      e.listeners.add(listener);
      if (!e.run && e.full.status === 'pending') start(file, e);
      return () => {
        e.listeners.delete(listener);
        queueMicrotask(() => {
          if (e.listeners.size || !e.run) return;
          e.run.abort();
          e.run = null;
        });
      };
    },
    prewarm(options) {
      void probe.prewarm(options);
      loadSummary().catch(noop);
    },
  };
}
