import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FILES_DIR, REPO_ROOT } from '../helpers/fixtures.ts';
import { installTarball } from './jest-project.ts';

const FILES = ['cfr_h264_30.mp4', 'cfr_vp9_29.97.webm', 'hdr10_hevc10.mp4', 'colr_nclc.mov', 'corrupt_trunc_moov_partial.mp4'];
const PEERS = ['mp4box', 'mediabunny'];
const REQUIRE_ESM_WARNING = /loading ES Module .*video-fps-probe.* using require\(\)/;
const WARNS_ON_REQUIRE_ESM = /^v22\.12\./.test(process.version);

const CONSUMER = `'use strict';
const { openAsBlob, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const [mode, out, files, base, ...names] = process.argv.slice(2);
const warnings = [];
process.on('warning', (w) => warnings.push({ name: w.name, message: w.message }));
const removed = [];
const removeAllListeners = process.removeAllListeners;
process.removeAllListeners = function (...args) {
  removed.push(String(args[0]));
  return removeAllListeners.apply(this, args);
};
const listeners = () => Object.fromEntries(process.eventNames().map((e) => [String(e), process.listenerCount(e)]));
const before = listeners();
const load = mode === 'import' ? (s) => import(s) : async (s) => require(s);
const plain = (value) => JSON.parse(JSON.stringify(value, (key, v) => (key === 'ms' || key === 'nativeStatsMs' ? 0 : v)));

async function main() {
  const root = await load('video-fps-probe');
  const header = await load('video-fps-probe/header');
  const url = await load('video-fps-probe/url');
  const { withColor } = await load('video-fps-probe/color');
  const { withAspect } = await load('video-fps-probe/aspect');
  const { check } = await load('video-fps-probe/check');
  const presets = await load('video-fps-probe/presets');
  const { mp4box } = await import('video-fps-probe/mp4box');
  const { mediabunny } = await import('video-fps-probe/mediabunny');
  const rules = Object.values(presets).filter((p) => p !== null && typeof p === 'object' && 'rules' in p).map((p) => p.rules);
  const runs = {};
  for (const name of names) {
    const blob = await openAsBlob(join(files, name));
    const own = await root.analyze(blob, { name, codecConfig: true });
    const source = await url.openRangeSource(url.httpRange(new URL(encodeURIComponent(name), base)));
    runs[name] = plain({
      own: withColor(withAspect(own, { keepCodecConfig: true })),
      checks: rules.map((r) => check(own, r)),
      mp4box: await root.analyze(blob, { name, engine: mp4box() }),
      mediabunny: await root.analyze(blob, { name, engine: mediabunny() }),
      header: await header.analyzeHeader(blob, { name, codecConfig: true, color: true, aspect: true }),
      ranged: await header.analyzeHeader(source, { name }),
      rangedFull: await root.analyze(source, { name }),
    });
  }
  await new Promise((done) => setImmediate(done));
  return { presets: rules.length, runs };
}

main().then(
  (run) => writeFileSync(out, JSON.stringify({ pid: process.pid, warnings, removed, before, after: listeners(), ...run })),
  (e) => {
    writeFileSync(out, JSON.stringify({ pid: process.pid, failed: String((e && e.stack) || e) }));
    process.exitCode = 1;
  },
);
`;

interface Arm {
  name: string;
  flags: string[];
  mode: 'import' | 'require';
  script: string;
  warns: boolean;
}

const ARMS: Arm[] = [
  { name: 'import', flags: [], mode: 'import', script: 'consumer.cjs', warns: false },
  { name: 'require() of the ESM build', flags: [], mode: 'require', script: 'consumer.cjs', warns: WARNS_ON_REQUIRE_ESM },
  { name: 'require() of the ESM build from a file inside node_modules', flags: [], mode: 'require', script: join('node_modules', 'silent-consumer', 'consumer.cjs'), warns: false },
  { name: 'require() of the CommonJS copy under --no-experimental-require-module', flags: ['--no-experimental-require-module'], mode: 'require', script: 'consumer.cjs', warns: false },
];

interface Child {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

interface Report {
  pid: number;
  failed?: string;
  warnings: { name: string; message: string }[];
  removed: string[];
  before: Record<string, number>;
  after: Record<string, number>;
  presets: number;
  runs: Record<string, Record<string, { error?: string | null; engine?: string; warnings?: string[]; videoTracks?: { warnings: string[] }[] }>>;
}

function runNode(cwd: string, args: string[]): Promise<Child> {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--pending-deprecation', ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => stdout.push(d));
    child.stderr.on('data', (d: Buffer) => stderr.push(d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString('utf8') }));
  });
}

const printed = (pid: number, w: { name: string; message: string }) => `(node:${pid}) ${w.name}: ${w.message}\n`;
const TRACE_HINT = /^\(Use `[^`]*--trace-warnings \.\.\.` to show where the warning was created\)\r?\n/;

describe(`the packed tarball writes nothing to stdout or stderr on Node ${process.versions.node}`, () => {
  let dir: string;
  let remove: () => void = () => undefined;
  let server: Server;
  let base: string;
  const reports = new Map<string, Report>();

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'silent-'));
    mkdirSync(join(dir, 'node_modules', 'silent-consumer'), { recursive: true });
    remove = installTarball({ name: 'silent', dir, bin: '', jest: '' });
    for (const peer of PEERS) cpSync(join(REPO_ROOT, 'node_modules', peer), join(dir, 'node_modules', peer), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'silent-project', private: true }));
    writeFileSync(join(dir, 'consumer.cjs'), CONSUMER);
    writeFileSync(join(dir, 'node_modules', 'silent-consumer', 'package.json'), JSON.stringify({ name: 'silent-consumer', version: '1.0.0' }));
    writeFileSync(join(dir, 'node_modules', 'silent-consumer', 'consumer.cjs'), CONSUMER);
    server = createServer((request, reply) => {
      const bytes = readFileSync(join(FILES_DIR, decodeURIComponent(new URL(request.url ?? '/', 'http://x/').pathname.slice(1))));
      const m = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '');
      if (!m) return reply.writeHead(200, { 'content-length': bytes.byteLength }).end(bytes);
      const first = Number(m[1]);
      const last = Math.min(Number(m[2]), bytes.byteLength - 1);
      reply.writeHead(206, { 'content-range': `bytes ${first}-${last}/${bytes.byteLength}`, 'content-length': last - first + 1 }).end(bytes.subarray(first, last + 1));
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });

  afterAll(async () => {
    await new Promise((done) => server?.close(done));
    remove();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it.each(ARMS)('$name: analyze, analyzeHeader, check, presets, color, aspect, the url entry and both engines', async (arm) => {
    const out = join(dir, `${reports.size}.json`);
    const child = await runNode(dir, [...arm.flags, arm.script, arm.mode, out, FILES_DIR, base, ...FILES]);
    const report = JSON.parse(readFileSync(out, 'utf8')) as Report;
    expect(report.failed, child.stderr).toBeUndefined();
    expect(child.code, child.stderr).toBe(0);
    expect(child.stdout.byteLength, child.stdout.toString('utf8')).toBe(0);
    if (arm.warns) {
      expect(report.warnings.map((w) => w.name)).toEqual(['ExperimentalWarning']);
      expect(report.warnings[0]!.message).toMatch(REQUIRE_ESM_WARNING);
      const rest = child.stderr.replace(printed(report.pid, report.warnings[0]!), '').replace(TRACE_HINT, '');
      expect(rest, child.stderr).toBe('');
    } else {
      expect(report.warnings).toEqual([]);
      expect(child.stderr).toBe('');
    }
    expect(report.removed, 'the package never calls process.removeAllListeners').toEqual([]);
    expect(report.after, 'the package adds no process listener').toEqual(report.before);
    expect(report.presets).toBeGreaterThan(0);
    expect(Object.keys(report.runs)).toEqual(FILES);
    const good = report.runs['cfr_h264_30.mp4']!;
    expect([good.own!.error, good.mp4box!.error, good.mediabunny!.error, good.header!.error, good.ranged!.error, good.rangedFull!.error]).toEqual([null, null, null, null, null, null]);
    expect([good.mp4box!.engine, good.mediabunny!.engine]).toEqual(['mp4box', 'mediabunny']);
    const logged = report.runs['colr_nclc.mov']!.mp4box!;
    expect([...logged.warnings!, ...logged.videoTracks!.flatMap((t) => t.warnings)].some((w) => w.startsWith('mp4box log: ')), 'mp4box logged through the hook').toBe(true);
    reports.set(arm.name, report);
  });

  it('gives the same results in every arm', () => {
    expect([...reports.keys()]).toEqual(ARMS.map((a) => a.name));
    const [first, ...rest] = [...reports.values()];
    for (const r of rest) expect(r.runs).toEqual(first!.runs);
  });
});
