import type { ArmInfo } from './engines.ts';
import { countVerdicts, type TrackEvaluation } from './rules.ts';
import { OUTCOME_CLASSES, VERDICTS, type CheckResult, type ContainerFamily, type FieldName, type OutcomeClass, type Verdict } from './types.ts';

export interface FixtureIo {
  reads: number;
  bytesRead: number;
  percent: number;
  ms: number;
  msFirst: number;
}

export interface FixtureReport {
  name: string;
  category: string;
  container: string;
  expect: string;
  sizeBytes: number;
  family: ContainerFamily | null;
  layout: { fragmented: boolean; hasSidx: boolean } | null;
  io: FixtureIo | null;
  appError: string | null;
  threw: string | null;
  scan: string | null;
  fileChecks: CheckResult[];
  tracks: TrackEvaluation[];
  notes: string[];
}

export interface SkippedFixture {
  name: string;
  reason: string;
}

export interface StaleDeviation {
  fixture: string;
  key: string;
}

export interface EngineReport {
  engine: string;
  informational: boolean;
  arm: ArmInfo;
  loadSkipped: string | null;
  fixtures: FixtureReport[];
  skipped: SkippedFixture[];
  deviationFiles: string[];
  deviationProblems: string[];
  staleDeviations: StaleDeviation[];
  counts: Record<Verdict, number>;
  outcomes: Record<OutcomeClass, number>;
  mismatchFixtures: string[];
  notProvided?: FieldName[];
}

export interface AccuracyReport {
  generator: string;
  generatedAt: string;
  node: string;
  ffprobeVersions: string[];
  options: { engines: string[]; withLarge: boolean; filter: string | null; repeat: number; matroskaMode: string };
  engines: EngineReport[];
}

export const OUTCOME_TEXT =
  "**wrong** (the arm returns a value that differs from ffprobe, and neither the arm's own definition nor another checked one explains it), **definition differs** (the value follows the definition the library documents or implements for the field, evaluated on the file and its reference: a float instead of the exact rational, mediabunny's frame rate metrics over its probe window, the movie or media header duration that mp4box.js reports, an end timestamp instead of a span), **unverified** (the arm's own definition cannot be evaluated on the file, or the value equals another quantity that the arm does not use for the field; counted neither as wrong nor as a definition difference), **not provided** (the arm returns no value for the field, or the field is not part of its recipe), **unsupported container** (the library does not read the container).";

export function esc(s: string | null | undefined): string {
  return (s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export function fixtureChecks(f: FixtureReport): CheckResult[] {
  return [...f.fileChecks, ...f.tracks.flatMap((t) => t.checks)];
}

export function tallyEngine(fixtures: readonly FixtureReport[]): { counts: Record<Verdict, number>; mismatchFixtures: string[] } {
  const all = fixtures.flatMap(fixtureChecks);
  const mismatchFixtures = fixtures.filter((f) => fixtureChecks(f).some((c) => c.verdict === 'mismatch')).map((f) => f.name);
  return { counts: countVerdicts(all), mismatchFixtures };
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

function fmtPercent(p: number): string {
  if (p >= 100) return '100';
  if (p >= 10) return p.toFixed(1);
  if (p >= 0.01) return p.toFixed(2);
  return p === 0 ? '0' : '<0.01';
}

function fmtMs(ms: number): string {
  if (ms >= 100) return ms.toFixed(0);
  if (ms >= 10) return ms.toFixed(1);
  return ms.toFixed(2);
}

function ratioDecimal(s: string | null): string {
  if (!s) return '-';
  const m = /^(-?\d+)\/(-?\d+)/.exec(s);
  if (!m || Number(m[2]) === 0) return s;
  const v = Number(m[1]) / Number(m[2]);
  return v >= 100 ? v.toFixed(1) : v.toFixed(3);
}

function pair(c: CheckResult | undefined): string {
  if (!c) return '-';
  const a = c.app ?? '-';
  if (c.verdict === 'exact' || c.verdict === 'n/a' || c.app === c.ffprobe) return a;
  return `${a} vs ${c.ffprobe ?? '-'}`;
}

function findCheck(checks: readonly CheckResult[], id: string): CheckResult | undefined {
  return checks.find((c) => c.id === id);
}

function avgCell(checks: readonly CheckResult[]): string {
  const main = findCheck(checks, 'avgFps') ?? findCheck(checks, 'avgFps.declared');
  const measured = findCheck(checks, 'avgFps.measured');
  let cell = pair(main);
  if (measured && measured.verdict !== 'n/a') cell += `; measured ${pair(measured)}`;
  return cell;
}

function rangeCell(checks: readonly CheckResult[]): string {
  const min = findCheck(checks, 'minFps');
  const max = findCheck(checks, 'maxFps');
  if (!min && !max) return '-';
  if (!min?.app && !max?.app) return 'none';
  return `${ratioDecimal(min?.app ?? null)}..${ratioDecimal(max?.app ?? null)}`;
}

export function verdictSummary(checks: readonly CheckResult[]): string {
  const by = new Map<Verdict, string[]>();
  for (const c of checks) {
    if (c.verdict === 'n/a') continue;
    const list = by.get(c.verdict) ?? [];
    list.push(c.id);
    by.set(c.verdict, list);
  }
  const exact = by.get('exact')?.length ?? 0;
  const rest = (['mismatch', 'known-deviation', 'within-tol'] as const)
    .filter((v) => by.has(v))
    .map((v) => `${v}: ${by.get(v)!.join(', ')}`);
  if (rest.length === 0 && exact > 0 && by.get('exact')!.every((id) => id === 'error')) return 'expected outcome (manifest)';
  if (rest.length === 0) return exact > 0 ? `all exact (${exact})` : 'n/a';
  return rest.join('; ');
}

function primaryFirst(tracks: readonly TrackEvaluation[]): TrackEvaluation[] {
  const primary = tracks.filter((t) => t.primary);
  return [...primary, ...tracks.filter((t) => !t.primary)];
}

function fixtureRows(f: FixtureReport): string[] {
  const io = f.io;
  const ioCells = io
    ? [String(io.reads), fmtBytes(io.bytesRead), fmtPercent(io.percent), fmtMs(io.ms)]
    : ['-', '-', '-', '-'];
  const rows: string[] = [];
  const cat = f.category;
  if (f.tracks.length === 0) {
    const verdict = verdictSummary(f.fileChecks);
    rows.push(`| ${esc(f.name)} | ${cat} | - | - | - | ${esc(verdict)} | ${ioCells.join(' | ')} |`);
    return rows;
  }
  primaryFirst(f.tracks).forEach((t, i) => {
    const checks = i === 0 ? [...f.fileChecks, ...t.checks] : t.checks;
    const label = i === 0 ? f.name : `${f.name} (track ${t.trackId})`;
    const frames = pair(findCheck(t.checks, 'frames'));
    const cells = i === 0 ? ioCells : ['', '', '', ''];
    rows.push(`| ${esc(label)} | ${cat} | ${esc(avgCell(t.checks))} | ${esc(frames)} | ${rangeCell(t.checks)} | ${esc(verdictSummary(checks))} | ${cells.join(' | ')} |`);
  });
  return rows;
}

function exceptionRows(f: FixtureReport): string[] {
  const rows: string[] = [];
  const emit = (c: CheckResult, track: number | null) => {
    if (c.verdict === 'exact' || c.verdict === 'n/a') return;
    const label = track === null || f.tracks.length < 2 ? f.name : `${f.name} (track ${track})`;
    let why: string;
    if (c.verdict === 'known-deviation') why = `${c.deviationSource === 'built-in' ? '[built-in] ' : ''}${c.deviation ?? ''}`;
    else why = [c.outcomeWhy, c.detail, c.verdict === 'mismatch' ? `rule: ${c.rule}` : null].filter(Boolean).join('. ');
    rows.push(`| ${esc(label)} | ${c.id} | ${esc(c.app ?? '-')} | ${esc(c.ffprobe ?? '-')} | ${c.outcome ?? c.verdict} | ${esc(why)} |`);
  };
  for (const c of f.fileChecks) emit(c, null);
  for (const t of f.tracks) for (const c of t.checks) emit(c, t.trackId);
  return rows;
}

const MATRIX_COLUMNS: ReadonlyArray<readonly [header: string, field: FieldName]> = [
  ['err', 'error'],
  ['sel', 'trackSelection'],
  ['avg', 'avgFps'],
  ['nom', 'nominalFps'],
  ['frm', 'frames'],
  ['prs', 'presentedFrames'],
  ['dur', 'durationSec'],
  ['srt', 'startSec'],
  ['fmt', 'formatDurationSec'],
  ['min', 'minFps'],
  ['max', 'maxFps'],
  ['vfr', 'isVfr'],
  ['dup', 'duplicateTimestamps'],
  ['cod', 'codecName'],
  ['w', 'width'],
  ['h', 'height'],
  ['mfi', 'medianFrameInterval'],
  ['sar', 'sampleAspectRatio'],
  ['dar', 'displayAspectRatio'],
  ['en', 'enabled'],
  ['rng', 'colorRange'],
  ['pri', 'colorPrimaries'],
  ['trc', 'colorTransfer'],
  ['spc', 'colorSpace'],
  ['bit', 'bitDepth'],
  ['prf', 'profile'],
  ['cs', 'codecString'],
  ['dv', 'dolbyVision'],
  ['lay', 'layout'],
  ['ec', 'errorCode'],
];

const VERDICT_SYMBOL: Record<Verdict, string> = { exact: '=', 'within-tol': '~', 'known-deviation': 'K', mismatch: 'X', 'n/a': '.' };
const VERDICT_RANK: Verdict[] = ['mismatch', 'known-deviation', 'within-tol', 'exact', 'n/a'];

function worstSymbol(checks: readonly CheckResult[], field: FieldName): string {
  const verdicts = checks.filter((c) => c.field === field).map((c) => c.verdict);
  if (verdicts.length === 0) return ' ';
  const worst = VERDICT_RANK.find((v) => verdicts.includes(v)) ?? 'n/a';
  return VERDICT_SYMBOL[worst];
}

function matrixRows(f: FixtureReport): string[] {
  if (f.tracks.length === 0) {
    return [`| ${esc(f.name)} | ${MATRIX_COLUMNS.map(([, field]) => worstSymbol(f.fileChecks, field)).join(' | ')} |`];
  }
  return primaryFirst(f.tracks).map((t, i) => {
    const checks = i === 0 ? [...f.fileChecks, ...t.checks] : t.checks;
    const label = i === 0 ? f.name : `${f.name} (track ${t.trackId})`;
    return `| ${esc(label)} | ${MATRIX_COLUMNS.map(([, field]) => worstSymbol(checks, field)).join(' | ')} |`;
  });
}

function renderMatrix(e: EngineReport): string[] {
  const out: string[] = [];
  out.push(`<details><summary>${e.engine}: verdict per field</summary>`);
  out.push('');
  out.push('Legend: `=` exact, `~` within-tol, `K` known-deviation, `X` mismatch, `.` n/a, blank = not checked. Columns: err = outcome vs manifest, sel = track selection, avg, nom = nominal/r_frame_rate, frm = frames, prs = presented frames, dur = track duration, srt = start, fmt = format duration, min/max = instantaneous FPS, vfr, dup = duplicate timestamps, cod = codec, w, h, mfi = median frame interval, sar and dar = sample and display aspect ratio, en = enabled flag, rng, pri, trc and spc = color range, primaries, transfer and space, bit = bit depth, prf = profile, cs = codec string, dv = Dolby Vision, lay = layout, ec = error code.');
  out.push('');
  out.push(`| Fixture | ${MATRIX_COLUMNS.map(([h]) => h).join(' | ')} |`);
  out.push(`|---|${MATRIX_COLUMNS.map(() => ':-:').join('|')}|`);
  for (const f of e.fixtures) out.push(...matrixRows(f));
  out.push('');
  out.push('</details>');
  out.push('');
  return out;
}

function groupSkipped(skipped: readonly SkippedFixture[]): string[] {
  const groups = new Map<string, string[]>();
  for (const s of skipped) {
    const list = groups.get(s.reason) ?? [];
    list.push(s.name);
    groups.set(s.reason, list);
  }
  return [...groups.entries()].map(([reason, names]) => {
    const shown = names.slice(0, 6).join(', ');
    return `- ${reason}: ${names.length} (${shown}${names.length > 6 ? ', ...' : ''})`;
  });
}

function libraryLabel(e: EngineReport): string {
  return e.arm.library === 'own' ? 'this package' : `${e.arm.library}${e.arm.version ? ` ${e.arm.version}` : ''}`;
}

function renderEngine(e: EngineReport): string[] {
  const out: string[] = [];
  out.push(`## ${e.engine}${e.informational ? ' (informational)' : ''}`);
  out.push('');
  out.push(`${libraryLabel(e)}, ${e.arm.style}: ${e.arm.recipe}.`);
  out.push('');
  if (e.loadSkipped) {
    out.push(`Skipped: ${e.loadSkipped}.`);
    out.push('');
    return out;
  }
  const dev = e.deviationFiles.length > 0 ? `known deviations from ${e.deviationFiles.map((f) => `\`${f}\``).join(', ')}` : 'no known-deviation file';
  out.push(`${e.fixtures.length} fixtures run, ${e.skipped.length} skipped, ${dev}.`);
  out.push('');
  if (e.notProvided && e.notProvided.length > 0) {
    out.push(`Not provided, so not checked: ${e.notProvided.map((f) => `\`${f}\``).join(', ')}.`);
    out.push('');
  }
  if (e.fixtures.length > 0) {
    out.push('| Fixture | Category | avg FPS (app, or app vs ffprobe) | frames | min..max FPS | Verdict | Reads | Bytes | % of file | ms |');
    out.push('|---|---|---|---|---|---|---:|---:|---:|---:|');
    for (const f of e.fixtures) out.push(...fixtureRows(f));
    out.push('');
  }
  if (e.fixtures.length > 0) out.push(...renderMatrix(e));
  const exceptions = e.fixtures.flatMap(exceptionRows);
  if (exceptions.length > 0) {
    out.push(`### ${e.engine}: deviations and mismatches`);
    out.push('');
    out.push('| Fixture | Field | App | ffprobe | Verdict or outcome | Reason or rule |');
    out.push('|---|---|---|---|---|---|');
    out.push(...exceptions);
    out.push('');
  }
  if (e.staleDeviations.length > 0) {
    out.push(`Stale known deviations (the check no longer mismatches): ${e.staleDeviations.map((s) => `${s.fixture}.${s.key}`).join(', ')}.`);
    out.push('');
  }
  if (e.deviationProblems.length > 0) {
    out.push('Known-deviation file problems:');
    out.push('');
    for (const p of e.deviationProblems) out.push(`- ${p}`);
    out.push('');
  }
  if (e.skipped.length > 0) {
    out.push('Skipped fixtures:');
    out.push('');
    out.push(...groupSkipped(e.skipped));
    out.push('');
  }
  return out;
}

export function serializeReport(report: AccuracyReport): string {
  const rules: Record<string, string> = {};
  const slim = (family: string | null, c: CheckResult) => {
    const key = `${family ?? 'unknown'}:${c.id}`;
    rules[key] ??= c.rule;
    const { rule, sub, detail, deviation, deviationSource, ...rest } = c;
    return {
      ...rest,
      ...(sub ? { sub } : {}),
      ...(detail ? { detail } : {}),
      ...(deviation ? { deviation, deviationSource } : {}),
      ruleKey: key,
      ...(rules[key] === rule ? {} : { rule }),
    };
  };
  const engines = report.engines.map((e) => ({
    ...e,
    fixtures: e.fixtures.map((f) => ({
      ...f,
      fileChecks: f.fileChecks.map((c) => slim(f.family, c)),
      tracks: f.tracks.map((t) => ({ ...t, checks: t.checks.map((c) => slim(f.family, c)) })),
    })),
  }));
  return `${JSON.stringify({ ...report, rules, engines }, null, 1)}
`;
}

export function renderMarkdown(report: AccuracyReport): string {
  const out: string[] = [];
  out.push('# Accuracy: app vs ffprobe');
  out.push('');
  out.push(
    `Generated by \`npm run compare\` (\`scripts/compare-ffprobe.ts\`) on Node ${report.node}. ffprobe references: ${report.ffprobeVersions.length > 0 ? report.ffprobeVersions.join('; ') : 'none found'}. Timings are the median of ${report.options.repeat} run(s) in Node, not in a browser; reads and bytes are unique reads through the shared reader.`,
  );
  out.push('');
  out.push('Verdicts: **exact** (equal under the research 6.4 rule), **within-tol** (inside the stated tolerance), **known-deviation** (differs from ffprobe, with a recorded reason), **mismatch** (unexpected), **n/a** (the rule does not apply). Only the `own` engine fails the run on a mismatch; library engines are informational.');
  out.push('');
  out.push(`Every mismatch has one outcome: ${OUTCOME_TEXT}`);
  out.push('');
  out.push('## Summary');
  out.push('');
  out.push('| Arm | Library | Role | Fixtures | Checks | exact | within-tol | known-deviation | wrong | definition differs | unverified | not provided | unsupported container | n/a |');
  out.push('|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const e of report.engines) {
    const role = e.informational ? 'informational' : 'gating';
    const library = libraryLabel(e);
    if (e.loadSkipped) {
      out.push(`| ${e.engine} | ${library} | ${role} | - | - | - | - | - | - | - | - | - | skipped: ${esc(e.loadSkipped)} | - |`);
      continue;
    }
    const total = VERDICTS.reduce((n, v) => n + e.counts[v], 0);
    out.push(
      `| ${e.engine} | ${library} | ${role} | ${e.fixtures.length} | ${total} | ${e.counts.exact} | ${e.counts['within-tol']} | ${e.counts['known-deviation']} | ${OUTCOME_CLASSES.map((k) => e.outcomes[k]).join(' | ')} | ${e.counts['n/a']} |`,
    );
  }
  out.push('');
  for (const e of report.engines) out.push(...renderEngine(e));
  return `${out.join('\n').trimEnd()}\n`;
}
