import type { AnalyzeOptions, AnalyzeProgress, FileResult } from '../core/types.ts';

export type WorkerEngine = 'own' | 'mp4box' | 'mediabunny';

export type WireOptions = Omit<AnalyzeOptions, 'signal' | 'onProgress'>;

export type WorkerRequest =
  | { type: 'analyze'; id: number; file: File; engine: WorkerEngine; options: WireOptions }
  | { type: 'cancel'; id: number };

export type WorkerResponse =
  | { type: 'progress'; id: number; progress: AnalyzeProgress }
  | { type: 'result'; id: number; result: FileResult }
  | { type: 'error'; id: number; message: string; aborted: boolean };
