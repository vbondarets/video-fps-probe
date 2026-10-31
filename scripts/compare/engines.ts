import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { analyze as analyzeInThread } from '../../src/analyze.ts';
import type { BlobLike } from '../../src/core/reader.ts';
import type { AnalyzeOptions, FileResult } from '../../src/core/types.ts';
import type { CheckResult, ContainerFamily, FieldName } from './types.ts';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const ENGINE_NAMES = ['own', 'mp4box-idiomatic', 'mp4box-tuned', 'mediabunny-idiomatic', 'mediabunny-full', 'mediabunny-tuned'] as const;
export type EngineName = (typeof ENGINE_NAMES)[number];

export const ENGINE_ALIASES: Readonly<Record<string, EngineName>> = { mp4box: 'mp4box-tuned', mediabunny: 'mediabunny-tuned' };

export type AnalyzeFn = (blob: BlobLike, name: string, opts: AnalyzeOptions) => Promise<FileResult>;

const analyzeOwn: AnalyzeFn = (blob, name, opts) => analyzeInThread(blob, { ...opts, name });

export type ArmLibrary = 'own' | 'mp4box' | 'mediabunny';
export type ArmStyle = 'own' | 'idiomatic' | 'full' | 'tuned';

export interface ArmSpec {
  library: ArmLibrary;
  style: ArmStyle;
  families: readonly ContainerFamily[];
  provides: ReadonlySet<FieldName> | null;
  requires?: Partial<Readonly<Record<ContainerFamily, readonly FieldName[]>>>;
  picksPrimary: boolean;
  primaryOnly: boolean;
  recipe: string;
}

export interface ArmInfo {
  library: ArmLibrary;
  style: ArmStyle;
  version: string | null;
  recipe: string;
}

const MP4BOX_FIELDS: ReadonlySet<FieldName> = new Set(['error', 'trackSelection', 'codecName', 'width', 'height', 'frames', 'durationSec', 'formatDurationSec']);
const MEDIABUNNY_FIELDS: ReadonlySet<FieldName> = new Set(['error', 'trackSelection', 'codecName', 'width', 'height', 'avgFps', 'nominalFps', 'minFps', 'maxFps', 'isVfr', 'startSec', 'durationSec', 'formatDurationSec']);
const MEDIABUNNY_FULL_FIELDS: ReadonlySet<FieldName> = new Set([...MEDIABUNNY_FIELDS, 'frames']);
const BOTH: readonly ContainerFamily[] = ['isobmff', 'matroska'];
const OWN_REQUIRED_FIELDS: readonly FieldName[] = [
  'avgFps',
  'nominalFps',
  'frames',
  'presentedFrames',
  'durationSec',
  'startSec',
  'formatDurationSec',
  'minFps',
  'maxFps',
  'isVfr',
  'duplicateTimestamps',
  'width',
  'height',
  'codecName',
  'error',
  'trackSelection',
  'medianFrameInterval',
  'enabled',
  'layout',
  'errorCode',
];

export const ARMS: Readonly<Record<EngineName, ArmSpec>> = {
  own: { library: 'own', style: 'own', families: BOTH, provides: null, requires: { isobmff: OWN_REQUIRED_FIELDS, matroska: OWN_REQUIRED_FIELDS }, picksPrimary: true, primaryOnly: false, recipe: 'analyze() of the root entry, the engine this package ships, with the reads and timings of a plain run and the color and aspect checks of a second run with codecConfig: true through withColor and withAspect' },
  'mp4box-idiomatic': {
    library: 'mp4box',
    style: 'idiomatic',
    families: ['isobmff'],
    provides: MP4BOX_FIELDS,
    picksPrimary: false,
    primaryOnly: false,
    recipe: 'README recipe: createFile(), appendBuffer() of 1 MiB chunks at the offset it asks for until onReady, then its info fields (codec, video width and height, nb_samples, track and movie duration over timescale); no frame rate, by design',
  },
  'mp4box-tuned': {
    library: 'mp4box',
    style: 'tuned',
    families: ['isobmff'],
    provides: null,
    picksPrimary: true,
    primaryOnly: false,
    recipe: "this package's adapter (video-fps-probe/engines/mp4box): boxes fed one by one, rates from the stts and ctts tables through this package's timeline statistics",
  },
  'mediabunny-idiomatic': {
    library: 'mediabunny',
    style: 'idiomatic',
    families: BOTH,
    provides: MEDIABUNNY_FIELDS,
    picksPrimary: true,
    primaryOnly: true,
    recipe: 'the README metadata recipe (Input + BlobSource, input.computeDuration(), getPrimaryVideoTrack()), then the track computeDuration() and computeFrameRateMetrics() with its defaults (256 packets); mediabunny fields only',
  },
  'mediabunny-full': {
    library: 'mediabunny',
    style: 'full',
    families: BOTH,
    provides: MEDIABUNNY_FULL_FIELDS,
    picksPrimary: true,
    primaryOnly: true,
    recipe: 'the idiomatic recipe with computeFrameRateMetrics({ targetPacketCount: Infinity }), its probedPacketCount as the frame count',
  },
  'mediabunny-tuned': {
    library: 'mediabunny',
    style: 'tuned',
    families: BOTH,
    provides: null,
    picksPrimary: true,
    primaryOnly: false,
    recipe: "this package's adapter (video-fps-probe/engines/mediabunny): every packet timestamp through this package's timeline statistics (min, max, VFR), the average from computePacketStats().averagePacketRate",
  },
};

export interface CheckedFixture {
  name: string;
  family: ContainerFamily | null;
  fileChecks: readonly Pick<CheckResult, 'field'>[];
  tracks: readonly { trackId: number | null; checks: readonly Pick<CheckResult, 'field'>[] }[];
}

const FAMILY_NAMES: Readonly<Record<ContainerFamily, string>> = { isobmff: 'ISO BMFF', matroska: 'Matroska' };

export function uncheckedRequiredFields(spec: ArmSpec, fixtures: readonly CheckedFixture[]): string[] {
  const out: string[] = [];
  const trackFields = new Set(fixtures.flatMap((f) => f.tracks.flatMap((t) => t.checks.map((c) => c.field))));
  for (const family of spec.families) {
    const ofFamily = fixtures.filter((f) => f.family === family);
    const checked = new Set(ofFamily.flatMap((f) => [...f.fileChecks, ...f.tracks.flatMap((t) => t.checks)].map((c) => c.field)));
    for (const field of spec.requires?.[family] ?? []) {
      if (!checked.has(field)) {
        out.push(`checks no ${field} on any ${FAMILY_NAMES[family]} fixture, a field it must provide`);
        continue;
      }
      if (!trackFields.has(field)) continue;
      const gaps = ofFamily.flatMap((f) => f.tracks.filter((t) => t.checks.length > 0 && !t.checks.some((c) => c.field === field)).map((t) => `${f.name} track ${t.trackId ?? 'none'}`));
      if (gaps.length > 0) out.push(`checks no ${field} on ${gaps.length} evaluated ${FAMILY_NAMES[family]} track(s), first ${gaps[0]}, a field it must provide on every track`);
    }
  }
  return out;
}

export interface EngineHandle {
  name: EngineName;
  informational: boolean;
  arm: ArmInfo;
  analyze: AnalyzeFn;
}

export interface EngineLoad {
  engine: EngineHandle | null;
  skipped: string | null;
}

export function isEngineName(s: string): s is EngineName {
  return (ENGINE_NAMES as readonly string[]).includes(s);
}

export function resolveEngineName(s: string): EngineName | null {
  return isEngineName(s) ? s : (ENGINE_ALIASES[s] ?? null);
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

function libraryVersion(library: ArmLibrary): string | null {
  if (library === 'own') return null;
  const path = join(REPO_ROOT, 'node_modules', library, 'package.json');
  return existsSync(path) ? ((JSON.parse(readFileSync(path, 'utf8')) as { version?: string }).version ?? null) : null;
}

async function loadIdiomatic(name: EngineName): Promise<AnalyzeFn> {
  const { analyzeMediabunnyRecipe, analyzeMp4boxRecipe } = await import('./idiomatic.ts');
  if (name === 'mp4box-idiomatic') return (blob, file) => analyzeMp4boxRecipe(blob, file);
  if (name === 'mediabunny-full') return (blob, file) => analyzeMediabunnyRecipe(blob, file, Infinity);
  return (blob, file) => analyzeMediabunnyRecipe(blob, file);
}

async function loadTuned(library: ArmLibrary): Promise<AnalyzeFn | string> {
  const file = join(REPO_ROOT, 'src', 'engines', `${library}.ts`);
  if (!existsSync(file)) return `src/engines/${library}.ts is not present`;
  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  } catch (e) {
    return `src/engines/${library}.ts failed to load: ${e instanceof Error ? e.message : String(e)}`;
  }
  return findAnalyzeExport(mod, library) ?? `src/engines/${library}.ts exports no analyze function`;
}

export async function loadEngine(name: EngineName): Promise<EngineLoad> {
  const spec = ARMS[name];
  const arm: ArmInfo = { library: spec.library, style: spec.style, version: libraryVersion(spec.library), recipe: spec.recipe };
  if (name === 'own') return { engine: { name, informational: false, arm, analyze: analyzeOwn }, skipped: null };
  if (spec.style === 'tuned') {
    const fn = await loadTuned(spec.library);
    return typeof fn === 'string' ? { engine: null, skipped: fn } : { engine: { name, informational: true, arm, analyze: fn }, skipped: null };
  }
  try {
    return { engine: { name, informational: true, arm, analyze: await loadIdiomatic(name) }, skipped: null };
  } catch (e) {
    return { engine: null, skipped: `${spec.library} failed to load: ${e instanceof Error ? e.message : String(e)}` };
  }
}
