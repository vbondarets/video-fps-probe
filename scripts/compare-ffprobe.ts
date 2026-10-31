import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { analyze as ownAnalyze } from '../src/core/analyze.ts';
import type { BlobLike } from '../src/core/reader.ts';
import { analyzeHeader, type HeaderResult } from '../src/header/index.ts';
import { emptyAnalysis } from '../src/core/result.ts';
import type { AnalyzeOptions, FileResult, MatroskaMode } from '../src/core/types.ts';
import { loadManifest, loadRef, fixturePath, type ManifestEntry } from '../tests/helpers/fixtures.ts';
import { openFixture } from '../tests/helpers/open-blob.ts';
import { forFixture, loadDeviations } from './compare/deviations.ts';
import { ARMS, ENGINE_ALIASES, ENGINE_NAMES, REPO_ROOT, loadEngine, resolveEngineName, uncheckedRequiredFields, type EngineHandle, type EngineName } from './compare/engines.ts';
import { mp4boxCodecStrings } from './compare/idiomatic.ts';
import { isoBmffFixtureSet, scanIsoBmffLayout, scanMatroskaLayout } from './compare/layout.ts';
import { classifyEvaluation, countOutcomes } from './compare/outcomes.ts';
import { parseRef, ticksToSec, type RefFile } from './compare/ref.ts';
import {
  renderMarkdown,
  serializeReport,
  tallyEngine,
  type AccuracyReport,
  type EngineReport,
  type FixtureReport,
  type SkippedFixture,
  type StaleDeviation,
} from './compare/report.ts';
import { EXACT_SECONDS_EPSILON, evaluate, noteContradictsLayout } from './compare/rules.ts';
import { runSelfTest } from './compare/self-test.ts';
import { FIELD_NAMES, OUTCOME_CLASSES, type FileLayout } from './compare/types.ts';

const DEVIATIONS_DIR = join(REPO_ROOT, 'fixtures', 'known-deviations');
const DEFAULT_REPEAT = 3;
const MATROSKA_MODES: readonly string[] = ['header', 'probe', 'exact', 'auto'];

const USAGE = `Usage: node scripts/compare-ffprobe.ts [options]

  --engines <list>       comma separated arms: ${ENGINE_NAMES.join(',')} (default: all, missing engines are skipped;
                         ${Object.entries(ENGINE_ALIASES).map(([a, n]) => `${a} means ${n}`).join(', ')})
  --with-large           also run fixtures/large (long and sparse files) when present
  --filter <substring>   only fixtures whose name contains the substring (writes accuracy.local.* instead)
  --repeat <n>           runs per fixture for the median timing (default ${DEFAULT_REPEAT})
  --mkv-mode <mode>      Matroska scan mode: header, probe, exact or auto (default auto)
  --out <dir>            report directory (default report)
  --no-write             print the summary only
  --verbose              keep console output of the library engines (muted by default)
  --header               check video-fps-probe/header instead of the arms: every ISO BMFF fixture in both
                         fragmentedDuration modes against the full own result and ffprobe, writes no report
  --self-test            check the comparison rules on hand-made cases and exit
  --help
`;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function failedResult(name: string, size: number, message: string): FileResult {
  return { name, size, ...emptyAnalysis('unknown', message), io: { reads: 0, bytesRead: 0, ms: 0 }, engine: 'own' };
}

function shapeOk(r: unknown): r is FileResult {
  return typeof r === 'object' && r !== null && Array.isArray((r as FileResult).videoTracks) && 'primaryTrackId' in r;
}

interface Timed {
  result: FileResult;
  threw: string | null;
  ms: number;
  msFirst: number;
}

async function withMutedConsole<T>(mute: boolean, fn: () => Promise<T>): Promise<T> {
  if (!mute) return fn();
  const saved = { log: console.log, info: console.info, debug: console.debug, warn: console.warn };
  const noop = () => {};
  console.log = noop;
  console.info = noop;
  console.debug = noop;
  console.warn = noop;
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
}

async function runTimed(engine: EngineHandle, blob: BlobLike, name: string, opts: AnalyzeOptions, repeat: number, mute: boolean): Promise<Timed> {
  return withMutedConsole(mute, () => runTimedInner(engine, blob, name, opts, repeat));
}

async function runTimedInner(engine: EngineHandle, blob: BlobLike, name: string, opts: AnalyzeOptions, repeat: number): Promise<Timed> {
  const times: number[] = [];
  let first: FileResult | null = null;
  let threw: string | null = null;
  for (let i = 0; i < repeat; i++) {
    const t0 = performance.now();
    try {
      const r = await engine.analyze(blob, name, opts);
      if (!shapeOk(r)) throw new Error('engine returned a value that is not a FileResult');
      const wall = performance.now() - t0;
      times.push(typeof r.io?.ms === 'number' && r.io.ms > 0 ? r.io.ms : wall);
      first ??= r;
    } catch (e) {
      threw = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      break;
    }
  }
  const result = first ?? failedResult(name, blob.size, threw ?? 'no result');
  return { result, threw, ms: times.length > 0 ? median(times) : 0, msFirst: times[0] ?? 0 };
}

function isLarge(entry: ManifestEntry): boolean {
  return !entry.committed || (entry.columns.path ?? '').startsWith('large/');
}

function printSummary(report: AccuracyReport): void {
  for (const e of report.engines) {
    if (e.loadSkipped) {
      console.log(`${e.engine.padEnd(20)} skipped: ${e.loadSkipped}`);
      continue;
    }
    const c = e.counts;
    console.log(
      `${e.engine.padEnd(20)} fixtures ${String(e.fixtures.length).padStart(3)}  exact ${c.exact}  within-tol ${c['within-tol']}  known-deviation ${c['known-deviation']}  mismatch ${c.mismatch}  n/a ${c['n/a']}${e.informational ? '  (informational)' : ''}`,
    );
    if (c.mismatch > 0) console.log(`${''.padEnd(20)} mismatches by outcome: ${OUTCOME_CLASSES.map((k) => `${k} ${e.outcomes[k]}`).join(', ')}`);
    if (e.mismatchFixtures.length > 0) {
      const shown = e.mismatchFixtures.slice(0, 12).join(', ');
      console.log(`${''.padEnd(20)} mismatch in ${e.mismatchFixtures.length} fixture(s): ${shown}${e.mismatchFixtures.length > 12 ? ', ...' : ''}`);
    }
    for (const p of e.deviationProblems) console.log(`${''.padEnd(20)} deviation file problem: ${p}`);
  }
}

const HEADER_TRACK_FIELDS = ['codecName', 'fourccOrCodecId', 'width', 'height', 'rotation', 'frames', 'isStill', 'enabled', 'durationSec', 'startSec', 'avgFpsFfprobe', 'sampleAspectRatio', 'displayWidth', 'displayHeight'] as const;
const HEADER_FILE_FIELDS = ['container', 'brand', 'formatDurationSec', 'layout', 'error', 'errorCode', 'audioTrackCount', 'primaryTrackId'] as const;
const NO_DURATION = 'incomplete header: fragmented file without a sidx, mfra or mehd duration';

const fields = (o: object, keys: readonly string[]): string => JSON.stringify(keys.map((k) => (o as Record<string, unknown>)[k] ?? null));

function frameInterval(t: FileResult['videoTracks'][number]): number {
  if (t.medianFrameInterval) return t.medianFrameInterval.value;
  return t.avgFps && t.avgFps.value > 0 ? 1 / t.avgFps.value : 0;
}

interface HeaderTally {
  exact: number;
  estimated: number;
  unresolved: number;
}

function checkHeader(name: string, mode: 'index' | 'header', h: HeaderResult, full: FileResult, ref: RefFile | null, fail: (text: string) => void): HeaderTally {
  const tally: HeaderTally = { exact: 0, estimated: 0, unresolved: 0 };
  const at = (text: string): void => fail(`${name} (${mode}): ${text}`);
  if (h.scan !== 'header') at(`scan is ${h.scan}`);
  if (h.io.reads > 8 || h.io.bytesRequested > 16 * 1024 * 1024) at(`read ${h.io.reads} times and requested ${h.io.bytesRequested} bytes under the default limits`);
  if (h.videoTracks.length !== full.videoTracks.length && (full.layout?.kind === 'fragmented' || h.error === null || h.videoTracks.length > 0)) {
    at(`${h.videoTracks.length} video tracks against ${full.videoTracks.length}`);
    return tally;
  }
  if (full.layout?.kind !== 'fragmented') {
    if (fields(h, HEADER_FILE_FIELDS) !== fields(full, HEADER_FILE_FIELDS)) at(`file fields ${fields(h, HEADER_FILE_FIELDS)} differ from full mode ${fields(full, HEADER_FILE_FIELDS)}`);
    h.videoTracks.forEach((t, i) => {
      const u = full.videoTracks[i];
      if (fields(t, HEADER_TRACK_FIELDS) !== fields(u, HEADER_TRACK_FIELDS)) at(`track ${t.trackId} ${fields(t, HEADER_TRACK_FIELDS)} differs from full mode ${fields(u, HEADER_TRACK_FIELDS)}`);
      else if (u.provenance.avgFps === 'header' && JSON.stringify(t.avgFps) !== JSON.stringify(u.avgFps)) at(`track ${t.trackId} avgFps differs where full mode reports the header average`);
      else tally.exact++;
    });
    return tally;
  }
  if (JSON.stringify(h.layout) !== JSON.stringify(full.layout)) at(`layout ${JSON.stringify(h.layout)} differs from ${JSON.stringify(full.layout)}`);
  if (h.errorCode !== null && h.errorCode !== 'no-duration' && h.errorCode !== full.errorCode) at(`error code ${h.errorCode} where full mode has ${full.errorCode}`);
  const estimated = h.videoTracks.some((t) => t.provenance.durationSec === 'estimated');
  if (h.formatDurationSec !== null && full.formatDurationSec !== null && h.formatDurationSec !== full.formatDurationSec && !estimated) at(`format duration ${h.formatDurationSec} against ${full.formatDurationSec}`);
  if (h.formatDurationSec === null && h.errorCode === null && !h.warnings.some((w) => w.startsWith('format duration unresolved: track '))) at('no format duration, no error and no unresolved-track warning');
  h.videoTracks.forEach((t, i) => {
    const u = full.videoTracks[i];
    if (t.isStill !== u.isStill || t.enabled !== u.enabled) at(`track ${t.trackId} isStill ${t.isStill} enabled ${t.enabled} against ${u.isStill} ${u.enabled}`);
    if (t.frames !== null || t.avgFps !== null || t.startSec !== null) at(`track ${t.trackId} reports per-fragment values`);
    if (t.durationSec === null) {
      tally.unresolved++;
      if (h.errorCode === null && !h.warnings.includes(`format duration unresolved: track ${t.trackId}`)) at(`track ${t.trackId} has no duration and the result says nothing`);
      return;
    }
    if (t.provenance.durationSec === 'estimated') {
      tally.estimated++;
      return;
    }
    const s = ref?.videoStreams[i];
    const expected = s && s.durationTs !== null ? ticksToSec(s.durationTs, s.timeBase) : u.durationSec;
    const tolerance = Math.abs((u.durationSec ?? 0) - (expected ?? 0)) + EXACT_SECONDS_EPSILON;
    if (u.durationSec === null || Math.abs(t.durationSec - u.durationSec) > frameInterval(u) + EXACT_SECONDS_EPSILON) at(`track ${t.trackId} duration ${t.durationSec} is not within one frame interval of full mode ${u.durationSec}`);
    else if (expected !== null && Math.abs(t.durationSec - expected) > tolerance) at(`track ${t.trackId} duration ${t.durationSec} against ffprobe ${expected}, full mode ${u.durationSec}`);
    else tally.exact++;
  });
  return tally;
}

async function runHeaderArm(entries: ManifestEntry[], withLarge: boolean, refOf: (name: string) => RefFile | null): Promise<number> {
  const failures: string[] = [];
  const fail = (text: string): void => {
    failures.push(text);
  };
  const usable = entries.filter((e) => (withLarge || !isLarge(e)) && fixturePath(e.name) !== null);
  const iso = new Set(await isoBmffFixtureSet(usable.map((e) => e.name), fixturePath));
  const totals = { fixtures: 0, fragmented: 0, exact: 0, estimated: 0, unresolved: 0 };
  const byName = new Map<string, Record<'index' | 'header', HeaderResult>>();
  for (const entry of usable.filter((e) => iso.has(e.name))) {
    const opened = await openFixture(fixturePath(entry.name)!);
    try {
      const full = await ownAnalyze(opened.blob, entry.name, {});
      const runs = { index: await analyzeHeader(opened.blob, { name: entry.name }), header: await analyzeHeader(opened.blob, { name: entry.name, fragmentedDuration: 'header' }) };
      byName.set(entry.name, runs);
      totals.fixtures++;
      if (full.layout?.kind === 'fragmented') totals.fragmented++;
      for (const mode of ['index', 'header'] as const) {
        const t = checkHeader(entry.name, mode, runs[mode], full, refOf(entry.name), fail);
        totals.exact += t.exact;
        totals.estimated += t.estimated;
        totals.unresolved += t.unresolved;
      }
    } finally {
      await opened.close();
    }
  }
  const expect = (name: string, mode: 'index' | 'header', test: (r: HeaderResult) => boolean, what: string): void => {
    const r = byName.get(name)?.[mode];
    if (!r) fail(`${name} (${mode}): missing from the run`);
    else if (!test(r)) fail(`${name} (${mode}): ${what}, got ${r.errorCode ?? 'no error'} and ${JSON.stringify(r.videoTracks.map((t) => [t.durationSec, t.provenance.durationSec ?? null]))}`);
  };
  const resolvedBy =
    (provenance: string) =>
    (r: HeaderResult): boolean =>
      r.error === null && (r.videoTracks.length > 0 || r.formatDurationSec !== null) && r.videoTracks.every((t) => t.durationSec !== null && t.provenance.durationSec === provenance);
  const names = [...byName.keys()];
  for (const name of names.filter((n) => n.includes('global_sidx'))) expect(name, 'index', resolvedBy('header'), 'a global sidx gives the exact duration');
  for (const name of names.filter((n) => /^rec_.*\.mp4$/.test(n) && !n.includes('_sliced'))) expect(name, 'index', resolvedBy('header'), 'a recording with an mfra gets the full-mode duration');
  for (const name of names.filter((n) => /^rec_.*_sliced\.mp4$/.test(n))) {
    for (const mode of ['index', 'header'] as const) expect(name, mode, (r) => r.errorCode === 'no-duration' && r.error === NO_DURATION && r.videoTracks.length > 0, 'a sliced recording has no duration');
  }
  expect('fmp4_mehd_valid.mp4', 'header', resolvedBy('estimated'), 'a valid mehd gives an estimated duration');
  console.log(
    `header: ${totals.fixtures} ISO BMFF fixtures (${totals.fragmented} fragmented) in both modes, ${totals.exact} track runs equal to full mode and ffprobe, ${totals.estimated} estimated from mehd, ${totals.unresolved} without a duration`,
  );
  for (const f of failures) console.error(`FAIL header: ${f}`);
  return failures.length > 0 ? 1 : 0;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      engines: { type: 'string' },
      'with-large': { type: 'boolean', default: false },
      filter: { type: 'string' },
      repeat: { type: 'string' },
      'mkv-mode': { type: 'string' },
      out: { type: 'string' },
      'no-write': { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
      'self-test': { type: 'boolean', default: false },
      header: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (values['self-test']) return runSelfTest();

  const engineNames: EngineName[] = [];
  for (const raw of (values.engines ?? ENGINE_NAMES.join(',')).split(',')) {
    const typed = raw.trim();
    if (!typed) continue;
    const n = resolveEngineName(typed);
    if (!n) {
      console.error(`unknown engine "${typed}" (known: ${[...ENGINE_NAMES, ...Object.keys(ENGINE_ALIASES)].join(', ')})`);
      return 2;
    }
    if (!engineNames.includes(n)) engineNames.push(n);
  }
  const repeat = values.repeat === undefined ? DEFAULT_REPEAT : Number(values.repeat);
  if (!Number.isInteger(repeat) || repeat < 1) {
    console.error('--repeat must be a positive integer');
    return 2;
  }
  const mkvMode = values['mkv-mode'] ?? 'auto';
  if (!MATROSKA_MODES.includes(mkvMode)) {
    console.error(`--mkv-mode must be one of ${MATROSKA_MODES.join(', ')}`);
    return 2;
  }
  const filter = values.filter?.toLowerCase() ?? null;
  const withLarge = values['with-large'] === true;
  const verbose = values.verbose === true;
  const outDir = values.out ?? join(REPO_ROOT, 'report');

  const manifest = loadManifest();
  if (manifest.length === 0) {
    console.error('fixtures/manifest.tsv is missing or empty');
    return 2;
  }
  const entries = manifest.filter((m) => !filter || m.name.toLowerCase().includes(filter));
  if (entries.length === 0) {
    console.error(`no fixture matches --filter ${values.filter}`);
    return 2;
  }

  const refCache = new Map<string, RefFile | null>();
  const refOf = (name: string): RefFile | null => {
    if (!refCache.has(name)) {
      const raw = loadRef(name);
      refCache.set(name, raw ? parseRef(name, raw) : null);
    }
    return refCache.get(name) ?? null;
  };
  const layoutCache = new Map<string, FileLayout | null>();
  const codecStringCache = new Map<string, Map<number, string> | null>();
  const codecStringsOf = async (name: string, blob: BlobLike, result: FileResult): Promise<Map<number, string> | null> => {
    if (!result.videoTracks.some((t) => (t as { color?: unknown }).color !== undefined)) return null;
    if (!codecStringCache.has(name)) codecStringCache.set(name, await withMutedConsole(!verbose, () => mp4boxCodecStrings(blob)).catch(() => null));
    return codecStringCache.get(name) ?? null;
  };
  if (values.header) return runHeaderArm(entries, withLarge, refOf);

  const harnessProblems = new Set<string>();
  const opts: AnalyzeOptions = { matroskaMode: mkvMode as MatroskaMode };
  const engineReports: EngineReport[] = [];

  for (const engineName of engineNames) {
    const { engine, skipped: loadSkipped } = await loadEngine(engineName);
    if (!engine) {
      engineReports.push({
        engine: engineName,
        informational: engineName !== 'own',
        arm: { library: ARMS[engineName].library, style: ARMS[engineName].style, version: null, recipe: ARMS[engineName].recipe },
        loadSkipped,
        fixtures: [],
        skipped: [],
        deviationFiles: [],
        deviationProblems: [],
        staleDeviations: [],
        counts: { exact: 0, 'within-tol': 0, 'known-deviation': 0, mismatch: 0, 'n/a': 0 },
        outcomes: countOutcomes([]),
        mismatchFixtures: [],
      });
      continue;
    }
    const deviations = loadDeviations(DEVIATIONS_DIR, engineName);
    const fixtures: FixtureReport[] = [];
    const skipped: SkippedFixture[] = [];
    const stale: StaleDeviation[] = [];

    for (const entry of entries) {
      if (isLarge(entry) && !withLarge) {
        skipped.push({ name: entry.name, reason: 'large fixture (use --with-large)' });
        continue;
      }
      const path = fixturePath(entry.name);
      if (!path) {
        const flag = entry.category === 'sparse' ? '--with-sparse' : entry.category === 'big' ? '--with-big' : '--with-long';
        skipped.push({ name: entry.name, reason: isLarge(entry) ? `optional file not present (generate it with npm run fixtures:generate -- ${flag})` : 'fixture file missing' });
        continue;
      }
      const ref = refOf(entry.name);
      const opened = await openFixture(path);
      try {
        const info = { name: entry.name, container: entry.container, category: entry.category, expect: entry.expect, notes: entry.notes, ...(entry.columns.code ? { code: entry.columns.code } : {}) };
        const isIso = entry.container === 'mp4' || entry.container === 'mov';
        const isMatroska = entry.container === 'webm' || entry.container === 'matroska';
        if (!layoutCache.has(entry.name)) {
          const scan = isIso ? scanIsoBmffLayout(path, opened.size) : isMatroska ? scanMatroskaLayout(path, opened.size) : Promise.resolve(null);
          layoutCache.set(entry.name, await scan.catch(() => null));
        }
        const layout = layoutCache.get(entry.name) ?? null;
        const contradiction = noteContradictsLayout(info, layout);
        if (contradiction) harnessProblems.add(contradiction);
        for (const s of ref?.videoStreams ?? []) for (const u of s.unmappedSideData) harnessProblems.add(`${entry.name} stream ${s.index}: ffprobe prints ${u}, which the comparison does not map`);
        const runs = engine.informational && isLarge(entry) ? 1 : repeat;
        const timed = await runTimed(engine, opened.blob, entry.name, opts, runs, engine.informational && !verbose);
        const result = timed.result;
        const codecStrings = isIso ? await codecStringsOf(entry.name, opened.blob, result) : null;
        const evaluation = evaluate({ info, ref, result, layout, threw: timed.threw, deviations: forFixture(deviations, entry.name), codecStrings });
        classifyEvaluation({ arm: ARMS[engineName], info, ref, result, layout, family: evaluation.family }, evaluation);
        for (const key of evaluation.unusedDeviationKeys) stale.push({ fixture: entry.name, key });
        const bytesRead = result.io?.bytesRead ?? 0;
        fixtures.push({
          name: entry.name,
          category: entry.category,
          container: entry.container,
          expect: entry.expect,
          sizeBytes: opened.size,
          family: evaluation.family,
          layout: isIso && layout ? { fragmented: layout.fragmented, hasSidx: layout.hasSidx } : null,
          io: {
            reads: result.io?.reads ?? 0,
            bytesRead,
            percent: opened.size > 0 ? (bytesRead / opened.size) * 100 : 0,
            ms: timed.ms,
            msFirst: timed.msFirst,
          },
          appError: result.error,
          threw: timed.threw,
          scan: result.scan,
          fileChecks: evaluation.fileChecks,
          tracks: evaluation.tracks,
          notes: evaluation.notes,
        });
      } finally {
        await opened.close();
      }
    }

    const problems = [...deviations.problems];
    if (!filter) {
      const known = new Set(manifest.map((m) => m.name));
      for (const fixture of deviations.byFixture.keys()) {
        if (!known.has(fixture)) problems.push(`known deviations name "${fixture}", which is not in manifest.tsv`);
      }
    }
    const { counts, mismatchFixtures } = tallyEngine(fixtures);
    const checked = new Set(fixtures.flatMap((f) => [...f.fileChecks, ...f.tracks.flatMap((t) => t.checks)]).map((c) => c.field));
    if (!filter) for (const gap of uncheckedRequiredFields(ARMS[engineName], fixtures)) harnessProblems.add(`the ${engineName} arm ${gap}`);
    engineReports.push({
      notProvided: FIELD_NAMES.filter((f) => !checked.has(f)),
      engine: engineName,
      informational: engine.informational,
      arm: engine.arm,
      loadSkipped: null,
      fixtures,
      skipped,
      deviationFiles: deviations.files,
      deviationProblems: problems,
      staleDeviations: stale,
      counts,
      outcomes: countOutcomes(fixtures.flatMap((f) => [...f.fileChecks, ...f.tracks.flatMap((t) => t.checks)])),
      mismatchFixtures,
    });
  }

  const versions = new Set<string>();
  for (const e of entries) {
    const v = refOf(e.name)?.ffprobeVersion;
    if (v) versions.add(v.replace(/ Copyright.*$/, ''));
  }
  const report: AccuracyReport = {
    generator: 'scripts/compare-ffprobe.ts',
    generatedAt: new Date().toISOString(),
    node: process.version,
    ffprobeVersions: [...versions],
    options: { engines: engineNames, withLarge, filter: values.filter ?? null, repeat, matroskaMode: mkvMode },
    engines: engineReports,
  };

  printSummary(report);
  if (!values['no-write']) {
    mkdirSync(outDir, { recursive: true });
    const stem = filter ? 'accuracy.local' : 'accuracy';
    writeFileSync(join(outDir, `${stem}.md`), renderMarkdown(report));
    writeFileSync(join(outDir, `${stem}.json`), serializeReport(report));
    console.log(`wrote ${join(outDir, `${stem}.md`)} and ${stem}.json`);
  }

  for (const problem of harnessProblems) console.error(`HARNESS: ${problem}`);
  if (harnessProblems.size > 0) return 2;
  const own = engineReports.find((e) => e.engine === 'own');
  if (own && !own.loadSkipped && own.counts.mismatch > 0) {
    console.error(`FAIL: ${own.counts.mismatch} unexpected mismatch(es) for the own engine in ${own.mismatchFixtures.length} fixture(s)`);
    return 1;
  }
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    console.error(e instanceof Error ? (e.stack ?? e.message) : e);
    process.exitCode = 2;
  },
);
