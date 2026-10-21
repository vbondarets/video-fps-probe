import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { BlobLike } from '../src/core/reader.ts';
import { emptyAnalysis } from '../src/core/result.ts';
import type { AnalyzeOptions, FileResult, MatroskaMode } from '../src/core/types.ts';
import { loadManifest, loadRef, fixturePath, type ManifestEntry } from '../tests/helpers/fixtures.ts';
import { openFixture } from '../tests/helpers/open-blob.ts';
import { forFixture, loadDeviations } from './compare/deviations.ts';
import { ENGINE_NAMES, REPO_ROOT, isEngineName, loadEngine, type EngineHandle, type EngineName } from './compare/engines.ts';
import { scanIsoBmffLayout } from './compare/layout.ts';
import { parseRef, type RefFile } from './compare/ref.ts';
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
import { evaluate } from './compare/rules.ts';
import { runSelfTest } from './compare/self-test.ts';

const DEVIATIONS_DIR = join(REPO_ROOT, 'fixtures', 'known-deviations');
const DEFAULT_REPEAT = 3;
const MATROSKA_MODES: readonly string[] = ['header', 'probe', 'exact', 'auto'];

const USAGE = `Usage: node scripts/compare-ffprobe.ts [options]

  --engines <list>       comma separated: ${ENGINE_NAMES.join(',')} (default: all, missing engines are skipped)
  --with-large           also run fixtures/large (long and sparse files) when present
  --filter <substring>   only fixtures whose name contains the substring (writes accuracy.local.* instead)
  --repeat <n>           runs per fixture for the median timing (default ${DEFAULT_REPEAT})
  --mkv-mode <mode>      Matroska scan mode: header, probe, exact or auto (default auto)
  --out <dir>            report directory (default report)
  --no-write             print the summary only
  --verbose              keep console output of the library engines (muted by default)
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
      console.log(`${e.engine.padEnd(11)} skipped: ${e.loadSkipped}`);
      continue;
    }
    const c = e.counts;
    console.log(
      `${e.engine.padEnd(11)} fixtures ${String(e.fixtures.length).padStart(3)}  exact ${c.exact}  within-tol ${c['within-tol']}  known-deviation ${c['known-deviation']}  mismatch ${c.mismatch}  n/a ${c['n/a']}${e.informational ? '  (informational)' : ''}`,
    );
    if (e.mismatchFixtures.length > 0) {
      const shown = e.mismatchFixtures.slice(0, 12).join(', ');
      console.log(`            mismatch in ${e.mismatchFixtures.length} fixture(s): ${shown}${e.mismatchFixtures.length > 12 ? ', ...' : ''}`);
    }
    for (const p of e.deviationProblems) console.log(`            deviation file problem: ${p}`);
  }
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
    const n = raw.trim();
    if (!n) continue;
    if (!isEngineName(n)) {
      console.error(`unknown engine "${n}" (known: ${ENGINE_NAMES.join(', ')})`);
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
  const opts: AnalyzeOptions = { matroskaMode: mkvMode as MatroskaMode };
  const engineReports: EngineReport[] = [];

  for (const engineName of engineNames) {
    const { engine, skipped: loadSkipped } = await loadEngine(engineName);
    if (!engine) {
      engineReports.push({
        engine: engineName,
        informational: engineName !== 'own',
        loadSkipped,
        fixtures: [],
        skipped: [],
        deviationFiles: [],
        deviationProblems: [],
        staleDeviations: [],
        counts: { exact: 0, 'within-tol': 0, 'known-deviation': 0, mismatch: 0, 'n/a': 0 },
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
        const info = { name: entry.name, container: entry.container, category: entry.category, expect: entry.expect, notes: entry.notes };
        const isIso = entry.container === 'mp4' || entry.container === 'mov';
        const layout = isIso ? await scanIsoBmffLayout(path, opened.size).catch(() => null) : null;
        const runs = engine.informational && isLarge(entry) ? 1 : repeat;
        const timed = await runTimed(engine, opened.blob, entry.name, opts, runs, engine.informational && !verbose);
        const result = timed.result;
        const evaluation = evaluate({ info, ref, result, layout, threw: timed.threw, deviations: forFixture(deviations, entry.name) });
        for (const key of evaluation.unusedDeviationKeys) stale.push({ fixture: entry.name, key });
        const bytesRead = result.io?.bytesRead ?? 0;
        fixtures.push({
          name: entry.name,
          category: entry.category,
          container: entry.container,
          expect: entry.expect,
          sizeBytes: opened.size,
          family: evaluation.family,
          layout: layout ? { fragmented: layout.fragmented, hasSidx: layout.hasSidx } : null,
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
    engineReports.push({
      engine: engineName,
      informational: engine.informational,
      loadSkipped: null,
      fixtures,
      skipped,
      deviationFiles: deviations.files,
      deviationProblems: problems,
      staleDeviations: stale,
      counts,
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
