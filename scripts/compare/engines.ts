import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { analyze as analyzeOwn } from '../../src/core/index.ts';
import type { BlobLike } from '../../src/core/reader.ts';
import type { AnalyzeOptions, FileResult } from '../../src/core/types.ts';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const ENGINE_NAMES = ['own', 'mp4box', 'mediabunny'] as const;
export type EngineName = (typeof ENGINE_NAMES)[number];

export type AnalyzeFn = (blob: BlobLike, name: string, opts: AnalyzeOptions) => Promise<FileResult>;

export interface EngineHandle {
  name: EngineName;
  informational: boolean;
  analyze: AnalyzeFn;
}

export interface EngineLoad {
  engine: EngineHandle | null;
  skipped: string | null;
}

export function isEngineName(s: string): s is EngineName {
  return (ENGINE_NAMES as readonly string[]).includes(s);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function findAnalyzeExport(mod: Record<string, unknown>, engine: string): AnalyzeFn | null {
  const preferred = ['analyze', `analyze${capitalize(engine)}`, 'default'];
  for (const key of preferred) {
    if (typeof mod[key] === 'function') return mod[key] as AnalyzeFn;
  }
  for (const [key, value] of Object.entries(mod)) {
    if (/^analy[sz]e/i.test(key) && typeof value === 'function') return value as AnalyzeFn;
  }
  return null;
}

export async function loadEngine(name: EngineName): Promise<EngineLoad> {
  if (name === 'own') {
    return { engine: { name, informational: false, analyze: analyzeOwn as AnalyzeFn }, skipped: null };
  }
  const file = join(REPO_ROOT, 'src', 'engines', `${name}.ts`);
  if (!existsSync(file)) return { engine: null, skipped: `src/engines/${name}.ts is not present` };
  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  } catch (e) {
    return { engine: null, skipped: `src/engines/${name}.ts failed to load: ${e instanceof Error ? e.message : String(e)}` };
  }
  const fn = findAnalyzeExport(mod, name);
  if (!fn) return { engine: null, skipped: `src/engines/${name}.ts exports no analyze function` };
  return { engine: { name, informational: true, analyze: fn }, skipped: null };
}
