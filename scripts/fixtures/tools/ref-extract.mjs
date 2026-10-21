#!/usr/bin/env node
// Writes the ffprobe ground truth for fixtures: <refDir>/<file name>.ref.json (schema 1).
// Usage: node ref-extract.mjs <refDir> <fileOrDir...>
// A directory argument stands for every regular file inside it (manifest.tsv and dotfiles are skipped).
// Output is deterministic for a given ffprobe build: no timings, no absolute paths.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const SCHEMA = 1;
const ARRAY_CAP = 20000;
const CONCURRENCY = 4;
const COUNT_FRAMES_MAX_BYTES = 2 ** 32;
const TAIL_REORDER_CAP = 16;
const VFR_REL_TOL = 0.005;

const [refDir, ...inputs] = process.argv.slice(2);
if (!refDir || inputs.length === 0) {
  console.error('usage: ref-extract.mjs <refDir> <fileOrDir...>');
  process.exit(2);
}
fs.mkdirSync(refDir, { recursive: true });

const files = inputs.flatMap((p) => {
  if (!fs.existsSync(p)) return [];
  if (!fs.statSync(p).isDirectory()) return [p];
  return fs
    .readdirSync(p)
    .filter((n) => n !== 'manifest.tsv' && !n.startsWith('.') && fs.statSync(path.join(p, n)).isFile())
    .sort()
    .map((n) => path.join(p, n));
});

async function ffprobe(args, cwd) {
  try {
    const { stdout, stderr } = await run('ffprobe', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 30 });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: typeof e.code === 'number' ? e.code : -1, stdout: e.stdout ?? '', stderr: e.stderr ?? String(e.message) };
  }
}

const versionLine = (await ffprobe(['-version'], process.cwd())).stdout.split(/\r?\n/)[0];

function cleanStderr(text, name) {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\[[^\]]*@ [0-9a-fA-FxX]+\] /, '').split(name).join('<file>').trim())
    .filter(Boolean);
}

function gcd(a, b) {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) [x, y] = [y, x % y];
  return x || 1;
}

function rational(num, den) {
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) return null;
  const g = gcd(num, den);
  return { num: num / g, den: den / g, value: num / den };
}

const toInt = (s) => (s === undefined || s === '' || s === 'N/A' ? null : Number(s));

function histogram(values) {
  const h = new Map();
  for (const v of values) h.set(v, (h.get(v) ?? 0) + 1);
  return Object.fromEntries([...h.entries()].sort((a, b) => a[0] - b[0]));
}

function fpsRange(deltas, tbNum, tbDen) {
  if (deltas.length === 0) return null;
  let mn = Infinity;
  let mx = -Infinity;
  for (const d of deltas) {
    if (d < mn) mn = d;
    if (d > mx) mx = d;
  }
  return {
    count: deltas.length,
    minDeltaTicks: mn,
    maxDeltaTicks: mx,
    distinctDeltas: new Set(deltas).size,
    minFps: rational(tbDen, mx * tbNum),
    maxFps: rational(tbDen, mn * tbNum),
  };
}

const parseRows = (csv) => csv.split(/\r?\n/).filter(Boolean).map((l) => l.split(','));

function legacyPacketStats(rows, timeBase) {
  const [tbN, tbD] = timeBase.split('/').map(Number);
  const toSec = (t) => (t * tbN) / tbD;
  const pts = [];
  const dur = [];
  const dts = [];
  let keyframes = 0;
  let discarded = 0;
  for (const [p, d, u, f] of rows) {
    if (p !== 'N/A' && p !== '') pts.push(Number(p));
    if (u !== 'N/A' && u !== '') dur.push(Number(u));
    if (d !== 'N/A' && d !== '') dts.push(Number(d));
    if (f && f.startsWith('K')) keyframes++;
    if (f && f.includes('D')) discarded++;
  }
  pts.sort((a, b) => a - b);
  const deltas = [];
  for (let i = 1; i < pts.length; i++) deltas.push(pts[i] - pts[i - 1]);
  const out = { packets: rows.length, keyframes, discardedPackets: discarded };
  if (deltas.length === 0) return out;
  let mn = Infinity;
  let mx = -Infinity;
  for (const d of deltas) {
    if (d < mn) mn = d;
    if (d > mx) mx = d;
  }
  const span = pts[pts.length - 1] - pts[0];
  const lastDur = dur.length ? dur[dur.length - 1] : mn;
  out.ptsDeltaMinTicks = mn;
  out.ptsDeltaMaxTicks = mx;
  out.distinctDeltas = new Set(deltas).size;
  out.minInstFps = mn > 0 ? 1 / toSec(mx) : null;
  out.maxInstFps = mn > 0 ? 1 / toSec(mn) : null;
  out.zeroDeltas = deltas.filter((d) => d === 0).length;
  out.ptsFirstSec = toSec(pts[0]);
  out.ptsLastSec = toSec(pts[pts.length - 1]);
  out.avgFpsFromPts = pts.length / toSec(span + lastDur);
  out.avgFpsFromSpan = deltas.length / toSec(span);
  out.durMinTicks = dur.length ? dur.reduce((a, b) => Math.min(a, b), Infinity) : null;
  out.durMaxTicks = dur.length ? dur.reduce((a, b) => Math.max(a, b), -Infinity) : null;
  out.vfrByDeltaRatio = mx / mn > 1.05;
  if (out.durMinTicks > 0) {
    out.minInstFpsByDur = 1 / toSec(out.durMaxTicks);
    out.maxInstFpsByDur = 1 / toSec(out.durMinTicks);
  }
  dts.sort((a, b) => a - b);
  if (dts.length > 1) {
    let dmn = Infinity;
    let dmx = -Infinity;
    for (let i = 1; i < dts.length; i++) {
      const d = dts[i] - dts[i - 1];
      if (d < dmn) dmn = d;
      if (d > dmx) dmx = d;
    }
    if (dmn > 0) {
      out.minInstFpsByDts = 1 / toSec(dmx);
      out.maxInstFpsByDts = 1 / toSec(dmn);
    }
  }
  return out;
}

function analyzePackets(rows, timeBase) {
  const [tbNum, tbDen] = timeBase.split('/').map(Number);
  let keyframes = 0;
  let discarded = 0;
  const presented = [];
  let minCts = Infinity;
  let maxCts = -Infinity;
  for (const [p, d, u, f = ''] of rows) {
    const pts = toInt(p);
    const dts = toInt(d);
    const dur = toInt(u);
    if (f.startsWith('K')) keyframes++;
    if (pts !== null && dts !== null) {
      minCts = Math.min(minCts, pts - dts);
      maxCts = Math.max(maxCts, pts - dts);
    }
    if (f.includes('D')) {
      discarded++;
      continue;
    }
    if (pts !== null) presented.push({ pts, dur: dur ?? 0 });
  }
  presented.sort((a, b) => a.pts - b.pts);
  const pts = presented.map((x) => x.pts);
  const deltas = [];
  for (let i = 1; i < pts.length; i++) deltas.push(pts[i] - pts[i - 1]);

  const duplicates = deltas.filter((d) => d <= 0).length;
  const positive = deltas.filter((d) => d > 0);
  const hasCts = Number.isFinite(maxCts) && maxCts > minCts;
  const reorderDepth = hasCts && positive.length ? Math.min(TAIL_REORDER_CAP, Math.ceil((maxCts - minCts) / positive[0])) : 0;
  const tailDropped = Math.min(positive.length, 1 + reorderDepth);
  const used = positive.slice(0, positive.length - tailDropped);

  let vfr = null;
  if (used.length > 0) {
    const sorted = [...used].sort((a, b) => a - b);
    const median = sorted[Math.floor((sorted.length - 1) / 2)];
    const tolerance = Math.max(1, Math.round(VFR_REL_TOL * median));
    vfr = {
      isVfr: used.some((d) => Math.abs(d - median) > tolerance),
      medianDeltaTicks: median,
      toleranceTicks: tolerance,
      vfrRatio: sorted[sorted.length - 1] / sorted[0],
    };
  }

  let avgFromPts = null;
  let lastPacketEnd = null;
  if (presented.length > 0) {
    const first = presented[0].pts;
    const last = presented[presented.length - 1];
    const end = last.pts + last.dur;
    avgFromPts = { frames: presented.length, firstPts: first, lastPts: last.pts, lastDurationTicks: last.dur, spanTicks: end - first, fps: rational(presented.length * tbDen, (end - first) * tbNum) };
    lastPacketEnd = { ticks: end, seconds: (end * tbNum) / tbDen };
  }

  const keep = presented.length <= ARRAY_CAP;
  return {
    timeBase,
    packets: rows.length,
    presentedPackets: presented.length,
    discardedPackets: discarded,
    keyframes,
    ptsPresented: keep ? pts : null,
    deltas: keep ? deltas : null,
    deltasExcludingTail: keep ? used : null,
    arraysOmitted: !keep,
    duplicateTimestamps: duplicates,
    reorderDepth,
    tailDropped,
    deltaHistogramAll: histogram(positive),
    deltaHistogramExcludingTail: histogram(used),
    instFpsAll: fpsRange(positive, tbNum, tbDen),
    instFpsExcludingTail: fpsRange(used, tbNum, tbDen),
    vfr,
    avgFromPts,
    lastPacketEnd,
  };
}

const optional = (v) => (v === undefined || v === 'N/A' ? undefined : v);
const orNull = (v) => (v === undefined || v === 'N/A' ? null : v);

function legacyFormat(f) {
  return { format_name: f.format_name, duration: optional(f.duration), size: optional(f.size), bit_rate: optional(f.bit_rate), nb_streams: f.nb_streams, start_time: optional(f.start_time) };
}

function ratio(text) {
  if (!text || text === '0/0') return null;
  const [n, d] = text.split('/').map(Number);
  return d ? n / d : n;
}

function legacyVideo(s, rows) {
  return {
    index: s.index,
    codec_name: s.codec_name,
    profile: s.profile,
    codec_tag_string: s.codec_tag_string,
    width: s.width,
    height: s.height,
    avg_frame_rate: s.avg_frame_rate,
    r_frame_rate: s.r_frame_rate,
    avg_fps: ratio(s.avg_frame_rate),
    r_fps: ratio(s.r_frame_rate),
    nb_frames: orNull(s.nb_frames),
    nb_read_frames: orNull(s.nb_read_frames),
    duration: orNull(s.duration),
    start_time: orNull(s.start_time),
    time_base: s.time_base,
    has_b_frames: s.has_b_frames,
    packets: legacyPacketStats(rows, s.time_base),
  };
}

async function extract(file) {
  const dir = path.dirname(file);
  const name = path.basename(file);
  const bytes = fs.statSync(file).size;
  const countFrames = bytes <= COUNT_FRAMES_MAX_BYTES;
  const args = ['-v', 'error', '-show_streams', '-show_format'];
  if (countFrames) args.push('-count_frames');
  args.push('-count_packets', '-show_optional_fields', 'always', '-of', 'json', name);

  const rec = { schema: SCHEMA, file: name, bytes, ffprobeVersion: versionLine, countFrames, ok: false, exitCode: null, stderr: [] };
  const probe = await ffprobe(args, dir);
  rec.exitCode = probe.code;
  rec.stderr = cleanStderr(probe.stderr, name);
  rec.probeExit = probe.code;
  rec.probeErr = rec.stderr[0] ?? null;

  let json = null;
  try {
    json = JSON.parse(probe.stdout);
  } catch {
    json = null;
  }
  if (!json || !json.format) {
    fs.writeFileSync(path.join(refDir, `${name}.ref.json`), serialize(rec));
    return `${name}\t${bytes}\tPROBE-FAIL\texit=${probe.code}\t${rec.stderr.join(' | ')}`;
  }
  rec.ok = true;
  rec.probe = json;
  rec.format = legacyFormat(json.format);
  rec.streams = (json.streams ?? []).map((s) => ({ index: s.index, codec_type: s.codec_type, codec_name: s.codec_name, attachedPic: s.disposition?.attached_pic === 1 }));
  const streams = json.streams ?? [];
  rec.attachedPicStreams = streams.filter((s) => s.codec_type === 'video' && s.disposition?.attached_pic === 1).map((s) => s.index);
  rec.videoStreams = [];
  rec.videos = [];
  for (const s of streams.filter((x) => x.codec_type === 'video' && x.disposition?.attached_pic !== 1)) {
    const pk = await ffprobe(['-v', 'error', '-select_streams', String(s.index), '-show_entries', 'packet=pts,dts,duration,flags', '-of', 'csv=p=0', name], dir);
    const rows = parseRows(pk.stdout);
    rec.videoStreams.push({ index: s.index, codecName: s.codec_name, width: s.width, height: s.height, ...analyzePackets(rows, s.time_base) });
    rec.videos.push(legacyVideo(s, rows));
  }
  fs.writeFileSync(path.join(refDir, `${name}.ref.json`), serialize(rec));
  const v = rec.videoStreams[0];
  return [name, bytes, json.format.format_name.split(',')[0], rec.videoStreams.length ? `${v.codecName} ${v.width}x${v.height}` : 'NO-VIDEO', v?.packets ?? '-', v?.vfr?.isVfr ?? '-'].join('\t');
}

function serialize(obj) {
  const text = JSON.stringify(obj, null, 2);
  return `${text.replace(/\[\n(\s+-?\d+(?:,\n\s+-?\d+)*)\n\s*\]/g, (_, body) => `[${body.trim().split(/,\n\s+/).join(', ')}]`)}\n`;
}

const queue = [...files];
const results = new Map();
async function worker() {
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    results.set(file, await extract(file));
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
for (const f of files) console.log(results.get(f));
console.log(`refs: ${files.length} files, ${versionLine}`);
