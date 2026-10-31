import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, openAsBlob, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { check } from '../../src/check/index.ts';
import { analyzeHeader } from '../../src/header/index.ts';
import { analyze } from '../../src/index.ts';
import { klingO1ReferenceVideo } from '../../src/presets/index.ts';
import { FILES_DIR, REPO_ROOT } from '../helpers/fixtures.ts';

const PACKAGE = 'video-fps-probe';
const FIXTURE = join(FILES_DIR, 'cfr_h264_30.mp4');

const DUAL = `import { openAsBlob } from 'node:fs';
import { createRequire } from 'node:module';
import * as esm from 'video-fps-probe';
import * as esmHeader from 'video-fps-probe/header';
import * as esmUrl from 'video-fps-probe/url';
import * as esmCheck from 'video-fps-probe/check';
import * as esmPresets from 'video-fps-probe/presets';

const require = createRequire(import.meta.url);
const cjs = require('video-fps-probe');
const cjsHeader = require('video-fps-probe/header');
const cjsUrl = require('video-fps-probe/url');
const cjsCheck = require('video-fps-probe/check');
const cjsPresets = require('video-fps-probe/presets');
const tail = (p) => p.split('\\\\').join('/').replace(/^.*\\/node_modules\\/video-fps-probe\\//, '');
const withoutMs = (r) => ({ ...r, io: { ...r.io, ms: 0 } });

const name = 'cfr_h264_30.mp4';
const blob = await openAsBlob(process.argv[2]);
const bytes = new Uint8Array(await blob.arrayBuffer());
const [esmResult, cjsResult] = await Promise.all([esm.analyze(blob, { name }), cjs.analyze(blob, { name })]);
const [esmHeaderResult, cjsHeaderResult] = await Promise.all([esmHeader.analyzeHeader(blob, { name }), cjsHeader.analyzeHeader(blob, { name })]);
const fetcher = async ({ start, end }) => ({ status: 206, contentRange: \`bytes \${start}-\${end - 1}/\${bytes.byteLength}\`, bytes: bytes.subarray(start, end) });
const crossedSource = await esmHeader.analyzeHeader(cjsUrl.rangeSource(fetcher, { size: bytes.byteLength }), { name });
const stopped = await cjsUrl.rangeSource(async () => ({ status: 200, bytes: bytes.subarray(0, 4) }), { size: bytes.byteLength }).read(0, 4).catch((e) => e);
const cut = await esmHeader.analyzeHeader(blob, { name, limits: { maxReads: 0 } });

process.stdout.write(JSON.stringify({
  resolved: { required: tail(require.resolve('video-fps-probe')), header: tail(require.resolve('video-fps-probe/header')) },
  distinct: [esm.analyze !== cjs.analyze, esmHeader.analyzeHeader !== cjsHeader.analyzeHeader, esmUrl.rangeSource !== cjsUrl.rangeSource, esmCheck.check !== cjsCheck.check, esmPresets.klingO1ReferenceVideo !== cjsPresets.klingO1ReferenceVideo, esm.ProbeError !== cjs.ProbeError],
  results: { esm: { ...esmResult, io: null }, cjs: { ...cjsResult, io: null }, esmHeader: withoutMs(esmHeaderResult), cjsHeader: withoutMs(cjsHeaderResult), crossedSource: withoutMs(crossedSource) },
  checks: {
    esmOnCjs: esmCheck.check(cjsResult, cjsPresets.klingO1ReferenceVideo.rules),
    cjsOnEsm: cjsCheck.check(esmResult, esmPresets.klingO1ReferenceVideo.rules),
    cjsOnEsmHeader: cjsCheck.check(esmHeaderResult, esmPresets.klingO1ReferenceVideo.rules),
  },
  guards: [
    cjs.isTimeoutError(new esm.ProbeError('timeout', 'x')),
    esm.isTimeoutError(new cjs.ProbeError('timeout', 'x')),
    cjs.isAbortError(new esm.ProbeError('aborted', 'x')),
    esmHeader.isAbortError(new cjs.ProbeError('aborted', 'x')),
    cjsHeader.isAbortError(new DOMException('x', 'AbortError')),
    esmHeader.isTimeoutError(new DOMException('x', 'TimeoutError')),
    cjs.isAbortError(new esm.ProbeError('timeout', 'x')),
  ],
  codes: [cjs.errorCodeOf(cut), esm.errorClass(cjsHeader.errorCodeOf(cut)), cjsHeader.warningCodeOf('ignored trailing data at 5'), esm.warningCodesOf(cjsHeaderResult)],
  rangeError: { name: stopped.name, code: stopped.code, ownClass: stopped instanceof cjsUrl.RangeSourceError, otherClass: stopped instanceof esmUrl.RangeSourceError },
}));
`;

describe('both copies in one process under --no-experimental-require-module', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dual-instance-'));
    const [{ filename }] = JSON.parse(execSync(`npm pack --ignore-scripts --json --pack-destination "${dir}"`, { cwd: REPO_ROOT, env: { ...process.env, npm_config_update_notifier: 'false' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) as { filename: string }[];
    execFileSync('tar', ['-xzf', filename!], { cwd: dir, stdio: 'ignore' });
    mkdirSync(join(dir, 'node_modules'));
    renameSync(join(dir, 'package'), join(dir, 'node_modules', PACKAGE));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dual-instance-consumer', private: true, type: 'module' }));
    writeFileSync(join(dir, 'dual.mjs'), DUAL);
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it(`loads the ESM and the CommonJS copy side by side on Node ${process.versions.node}, crosses results between them and keeps the guards true`, async () => {
    const out = JSON.parse(execFileSync(process.execPath, ['--no-experimental-require-module', 'dual.mjs', FIXTURE], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) as Record<string, Record<string, unknown> | unknown[]>;
    const name = 'cfr_h264_30.mp4';
    const blob = await openAsBlob(FIXTURE);
    const result = JSON.parse(JSON.stringify({ ...(await analyze(blob, { name })), io: null }));
    const header = await analyzeHeader(blob, { name });
    const headerResult = JSON.parse(JSON.stringify({ ...header, io: { ...header.io, ms: 0 } }));
    const report = JSON.parse(JSON.stringify(check(result, klingO1ReferenceVideo.rules)));
    expect(out.resolved).toEqual({ required: 'dist/cjs/index.cjs', header: 'dist/cjs/header.cjs' });
    expect(out.distinct).toEqual([true, true, true, true, true, true]);
    expect(out.results).toEqual({ esm: result, cjs: result, esmHeader: headerResult, cjsHeader: headerResult, crossedSource: headerResult });
    expect(out.checks).toEqual({ esmOnCjs: report, cjsOnEsm: report, cjsOnEsmHeader: JSON.parse(JSON.stringify(check(header, klingO1ReferenceVideo.rules))) });
    expect(out.guards).toEqual([true, true, true, true, true, true, false]);
    expect(out.codes).toEqual(['read-limit', 'limit', 'trailing-data', []]);
    expect(out.rangeError).toEqual({ name: 'RangeSourceError', code: 'unexpected-status', ownClass: true, otherClass: false });
  });
});
