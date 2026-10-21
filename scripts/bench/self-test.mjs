import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser } from './browser.mjs';
import { renderMarkdown } from './report.mjs';
import { mimeOf, parseRange, resolveRequest, startServer } from './server.mjs';
import { agreement, compareRuns, diffPaths, fmtPct, geomean, median, minimum, sameRate, summarize } from './values.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function track(avg, frames, extra = {}) {
  return { trackId: 1, avgFps: avg, frames, presentedFrames: frames, minFps: avg, maxFps: avg, isVfr: false, ...extra };
}

function result(avg, frames, io = { reads: 2, bytesRead: 100, ms: 1.5 }, extra = {}) {
  return { name: 'a.mp4', size: 1000, container: 'mp4', error: null, scan: null, primaryTrackId: 1, videoTracks: avg ? [track(avg, frames)] : [], io, ...extra };
}

export async function runSelfTest() {
  const checks = [];
  const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail });

  for (const [ext, type] of [
    ['x.js', 'text/javascript'],
    ['x.mjs', 'text/javascript'],
    ['x.wasm', 'application/wasm'],
    ['x.mp4', 'video/mp4'],
    ['x.webm', 'video/webm'],
    ['x.mkv', 'video/x-matroska'],
    ['x.mov', 'video/quicktime'],
    ['X.MP4', 'video/mp4'],
    ['x.unknown', 'application/octet-stream'],
  ]) {
    check(`mime ${ext}`, mimeOf(ext).startsWith(type), mimeOf(ext));
  }

  const root = resolve(HERE);
  check('resolve index', resolveRequest(root, '/') === join(root, 'index.html'));
  check('resolve file', resolveRequest(root, '/app.mjs') === join(root, 'app.mjs'));
  check('resolve dot segments stay inside', resolveRequest(root, '/%2e%2e/%2e%2e/package.json') === join(root, 'package.json'));
  check('resolve encoded slash traversal', resolveRequest(root, '/..%2f..%2fpackage.json') === null);
  check('resolve backslash traversal', resolveRequest(root, '/..%5c..%5cpackage.json') === null || process.platform !== 'win32');
  check('resolve bad escape', resolveRequest(root, '/%zz') === null);

  check('range start-end', JSON.stringify(parseRange('bytes=0-9', 100)) === '{"start":0,"end":9}');
  check('range open end', JSON.stringify(parseRange('bytes=90-', 100)) === '{"start":90,"end":99}');
  check('range suffix', JSON.stringify(parseRange('bytes=-10', 100)) === '{"start":90,"end":99}');
  check('range clamp', JSON.stringify(parseRange('bytes=95-500', 100)) === '{"start":95,"end":99}');
  check('range unsatisfiable', parseRange('bytes=200-300', 100) === 'unsatisfiable');
  check('range malformed', parseRange('items=0-1', 100) === null);

  check('median odd', median([3, 1, 2]) === 2);
  check('median even', median([4, 1, 2, 3]) === 2.5);
  check('median ignores null', median([null, 5, NaN]) === 5);
  check('median empty', median([]) === null);
  check('minimum', minimum([3, null, 1.5]) === 1.5);
  check('geomean', Math.abs(geomean([1, 4]) - 2) < 1e-12);

  const r30 = { num: 30, den: 1, value: 30 };
  const r60over2 = { num: 60, den: 2, value: 30 };
  const ntsc = { num: 30000, den: 1001, value: 30000 / 1001 };
  check('sameRate reduced', sameRate(r30, r60over2));
  check('sameRate differs', !sameRate(r30, ntsc));
  check('sameRate nulls', sameRate(null, null) && !sameRate(r30, null));

  check('agreement same', agreement(result(r30, 90), result(r60over2, 90)) === 'same');
  check('agreement frames', agreement(result(r30, 90), result(r30, 91)) === 'avg same, frames differ');
  check('agreement percent', agreement(result(r30, 90), result(ntsc, 90)).startsWith('avg -0.10%'));
  check('agreement error', agreement(result(r30, 90), result(null, null, undefined, { error: 'boom' })) === 'error');
  check('agreement not run', agreement(result(r30, 90), null) === 'not run');
  check('agreement no video', agreement(result(null, null), result(null, null)) === 'no video');

  const a = result(r30, 90, { reads: 2, bytesRead: 100, ms: 1.5 });
  const b = result(r30, 90, { reads: 2, bytesRead: 100, ms: 9.9 });
  check('compare ignores io.ms', compareRuns(a, b).identical);
  const c = result(r30, 90, { reads: 3, bytesRead: 100, ms: 1.5 });
  const cr = compareRuns(a, c);
  check('compare sees reads', !cr.identical && cr.keyFieldsEqual && cr.diffs[0].startsWith('.io.reads'), cr.diffs.join('; '));
  const dr = compareRuns(a, result(ntsc, 90));
  check('compare key fields', !dr.keyFieldsEqual && dr.keyFieldDiffs.includes('avg'), dr.keyFieldDiffs.join(','));
  check('diffPaths arrays', diffPaths({ x: [1, 2] }, { x: [1, 3] })[0] === '.x[1]: 2 vs 3');
  check('summarize primary', summarize(result(r30, 90)).avg === '30/1' && summarize(result(r30, 90)).frames === 90);
  check('fmtPct zero size', fmtPct(0, 0) === '-');

  check('findBrowser missing CHROME_PATH', findBrowser('chrome', { CHROME_PATH: join(root, 'no-such-browser.exe') }) === null);
  check('findBrowser explicit path', findBrowser('chrome', { CHROME_PATH: join(root, 'app.mjs') }) === join(root, 'app.mjs'));

  const md = renderMarkdown({
    command: 'node scripts/bench/run-bench.mjs',
    options: { reps: 1, engineReps: 1, coldReps: 1 },
    fixtures: [{ name: 'a.mp4', category: 'cfr', size: 1000 }],
    chrome: { warm: { 'a.mp4': { medianMs: 1, minMs: 1, medianWallMs: 2, reads: 2, bytesRead: 100, size: 1000, container: 'mp4' } } },
    environment: { chrome: { product: 'Chrome/1' } },
    totalSeconds: 1,
  });
  check('render minimal', md.startsWith('# Browser benchmark') && md.includes('| a.mp4 | mp4 |'));
  check('render ascii dashes', !/[\u2013\u2014]/.test(md));

  const server = await startServer(HERE);
  try {
    const js = await fetch(`${server.url}app.mjs`);
    const body = await js.text();
    check('serve js', js.status === 200 && js.headers.get('content-type').startsWith('text/javascript') && body === readFileSync(join(HERE, 'app.mjs'), 'utf8'));
    check('serve no-store', js.headers.get('cache-control') === 'no-store');
    const part = await fetch(`${server.url}app.mjs`, { headers: { Range: 'bytes=0-4' } });
    check('serve range', part.status === 206 && (await part.text()) === body.slice(0, 5) && part.headers.get('content-range').startsWith('bytes 0-4/'));
    const missing = await fetch(`${server.url}nope.js`);
    check('serve 404', missing.status === 404);
    const outside = await fetch(`${server.url}..%2f..%2fpackage.json`);
    check('serve no traversal', outside.status === 404);
    check('server log', server.log.length === 4 && server.log[0].bytes === body.length);
  } finally {
    await server.close();
  }

  const failed = checks.filter((x) => !x.ok);
  for (const f of failed) console.error(`FAIL ${f.name}${f.detail ? `: ${f.detail}` : ''}`);
  console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
  return failed.length === 0;
}
