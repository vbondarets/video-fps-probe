import { useSyncExternalStore } from 'react';
import { isAbortError as isAbort } from '../api/errors.ts';
import { lazyProbeFrom } from '../client/lazy.ts';
import type { AnalyzeProgress, FileResult, MatroskaMode } from '../core/types.ts';
import type { ExportAction, ExportOutcome } from './deviceInfo.ts';

export type CompareEngine = 'mp4box' | 'mediabunny' | 'rvfc';

export interface Run {
  busy: boolean;
  result: FileResult | null;
  error: string | null;
  progress: AnalyzeProgress | null;
  cancel: (() => void) | null;
}

export interface Row {
  id: number;
  file: File;
  busy: boolean;
  result: FileResult | null;
  error: string | null;
  progress: AnalyzeProgress | null;
  cancel: (() => void) | null;
  compare: Partial<Record<CompareEngine, Run>>;
}

export interface State {
  rows: Row[];
  mode: MatroskaMode;
}

declare global {
  interface Window {
    __fpsProbe?: {
      readonly results: FileResult[];
      readonly pending: number;
      runEngine(index: number, engine: CompareEngine): Promise<FileResult>;
    };
  }
}

let state: State = { rows: [], mode: 'auto' };
let nextRow = 1;
const listeners = new Set<() => void>();
const hosts = new Map<number, HTMLElement>();
const probe = lazyProbeFrom(() => import('./probe.ts').then((m) => m.probe));

const message = (e: unknown) => (e instanceof Error ? e.message || e.name : String(e));
const find = (id: number) => state.rows.find((r) => r.id === id);
const isMatroska = (r: FileResult) => r.container === 'webm' || r.container === 'matroska';
const isIso = (r: FileResult) => r.container === 'mp4' || r.container === 'mov';

function commit(next: State): void {
  state = next;
  listeners.forEach((l) => l());
}

function patch(id: number, p: Partial<Row>): void {
  if (!find(id)) return;
  commit({ ...state, rows: state.rows.map((r) => (r.id === id ? { ...r, ...p } : r)) });
}

function patchRun(id: number, engine: CompareEngine, p: Partial<Run>): void {
  const row = find(id);
  if (!row) return;
  const prev = row.compare[engine] ?? { busy: false, result: null, error: null, progress: null, cancel: null };
  patch(id, { compare: { ...row.compare, [engine]: { ...prev, ...p } } });
}

function start(id: number, mode: MatroskaMode, followMode = true): void {
  const row = find(id);
  if (!row) return;
  const controller = new AbortController();
  const job = probe.analyze(row.file, { matroskaMode: mode, signal: controller.signal, onProgress: (progress) => patch(id, { progress }) });
  patch(id, { busy: true, progress: null, cancel: () => controller.abort() });
  job.then(
    (result) => {
      patch(id, { busy: false, result, error: null, progress: null, cancel: null });
      if (followMode && isMatroska(result) && state.mode !== mode) start(id, state.mode);
    },
    (e) => {
      const prev = find(id);
      const error = isAbort(e) ? (prev?.result ? prev.error : 'Cancelled') : message(e);
      patch(id, { busy: false, error, progress: null, cancel: null });
    },
  );
}

export function addFiles(files: File[]): void {
  if (files.length === 0) return;
  const rows = files.map((file): Row => ({ id: nextRow++, file, busy: false, result: null, error: null, progress: null, cancel: null, compare: {} }));
  commit({ ...state, rows: [...state.rows, ...rows] });
  for (const row of rows) start(row.id, state.mode);
}

export function rescan(id: number, mode: MatroskaMode): void {
  start(id, mode, false);
}

export function cancelRow(id: number): void {
  find(id)?.cancel?.();
}

export function setMode(mode: MatroskaMode): void {
  if (mode === state.mode) return;
  commit({ ...state, mode });
  for (const row of state.rows) {
    if (row.result && isMatroska(row.result) && !row.busy) start(row.id, mode);
  }
}

export function clearAll(): void {
  for (const row of state.rows) {
    row.cancel?.();
    for (const run of Object.values(row.compare)) run?.cancel?.();
  }
  commit({ ...state, rows: [] });
}

export function registerHost(id: number, el: HTMLElement | null): void {
  if (el) hosts.set(id, el);
  else hosts.delete(id);
}

export async function runCompare(id: number, engine: CompareEngine): Promise<FileResult> {
  const row = find(id);
  if (!row) throw new RangeError(`no row ${id}`);
  const controller = new AbortController();
  let float: HTMLElement | null = null;
  patchRun(id, engine, { busy: true, result: null, error: null, progress: null, cancel: () => controller.abort() });
  try {
    let host: HTMLElement | undefined;
    if (engine === 'rvfc') {
      host = hosts.get(id);
      if (!host?.isConnected) host = float = document.body.appendChild(Object.assign(document.createElement('div'), { className: 'rvfc-host rvfc-float' }));
    }
    const result = await probe.analyze(row.file, { engine, host, signal: controller.signal, onProgress: (progress) => patchRun(id, engine, { progress }) });
    patchRun(id, engine, { busy: false, result, progress: null, cancel: null });
    return result;
  } catch (e) {
    patchRun(id, engine, { busy: false, error: isAbort(e) ? 'Cancelled' : message(e), progress: null, cancel: null });
    throw e;
  } finally {
    float?.remove();
  }
}

export function autoCompare(id: number): void {
  const row = find(id);
  if (!row?.result) return;
  const engines: CompareEngine[] = isIso(row.result) ? ['mp4box', 'mediabunny'] : ['mediabunny'];
  for (const engine of engines) {
    if (!row.compare[engine]) runCompare(id, engine).catch(() => {});
  }
}

type DeviceModule = typeof import('./deviceInfo.ts');

let device: DeviceModule | null = null;

export function loadDevice(): Promise<DeviceModule> {
  return import('./deviceInfo.ts').then((m) => (device = m));
}

export function exportJson(action: ExportAction): Promise<ExportOutcome> {
  const run = (d: DeviceModule) => d.exportResults(state.rows, { matroskaMode: state.mode }, action);
  return device ? run(device) : loadDevice().then(run);
}

export function useStore(): State {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

window.__fpsProbe = {
  get results() {
    return state.rows.flatMap((r) => (r.result ? [r.result] : []));
  },
  get pending() {
    return state.rows.filter((r) => r.busy).length;
  },
  runEngine(index, engine) {
    const row = state.rows.filter((r) => r.result)[index];
    return row ? runCompare(row.id, engine) : Promise.reject(new RangeError(`no result at index ${index}`));
  },
};
