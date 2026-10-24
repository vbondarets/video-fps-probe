#!/usr/bin/env node
// Records a canvas animation with MediaRecorder in headless Playwright browsers (the Tier R recorder corpus).
// Usage: node record-mediarecorder.mjs [outDir] [--browsers chromium,webkit] [--list]
//   outDir      where the recordings go, default <repo>/fixtures/files
//   --browsers  comma separated: chromium, webkit, firefox (default chromium,webkit)
//   --list      print which of TYPES each browser can record, then exit
// Every supported type is recorded twice, in one piece and with a 250 ms timeslice (_sliced), and named
// after the type the recorder reports: rec_<browser>_<codec>[_sliced].<webm|mkv|mp4>. The drawing is the
// same in every run; the frame timing is whatever the browser delivers: rAF for 1.5 s, a 0.6 s freeze,
// a 15 fps timer until 3.6 s, then rAF until 4.5 s. One JSON line of provenance per file goes to stdout.
// The output is not byte-reproducible: commit a recording once and keep it.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium, firefox, webkit } from '@playwright/test';

const HERE = dirname(fileURLToPath(import.meta.url));
const LAUNCHERS = { chromium, webkit, firefox };
const TYPES = [
  { label: 'vp8', mime: 'video/webm;codecs=vp8' },
  { label: 'vp9', mime: 'video/webm;codecs=vp9' },
  { label: 'av1', mime: 'video/webm;codecs=av1' },
  { label: 'h264', mime: 'video/webm;codecs=h264' },
  { label: 'avc1', mime: 'video/mp4;codecs=avc1' },
  { label: 'mp4', mime: 'video/mp4' },
];
const SETTINGS = { width: 320, height: 180, bitrate: 250_000, timeslice: 250, phases: { rafUntil: 1500, freezeMs: 600, timerUntil: 3600, timerFps: 15, endAt: 4500 } };

async function recordInPage({ mime, timeslice, width, height, bitrate, phases }) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  document.body.append(canvas);
  const ctx = canvas.getContext('2d');
  let frame = 0;
  const draw = () => {
    frame++;
    ctx.fillStyle = `hsl(${(frame * 7) % 360} 60% 35%)`;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#fff';
    ctx.font = '32px monospace';
    ctx.fillText(String(frame), 12, 44);
    ctx.fillRect((frame * 5) % (width - 24), height - 36, 24, 24);
  };
  draw();
  const stream = canvas.captureStream();
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate });
  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  const stopped = new Promise((done) => {
    recorder.onstop = done;
  });
  if (timeslice) recorder.start(timeslice);
  else recorder.start();
  const t0 = performance.now();
  const elapsed = () => performance.now() - t0;
  const onFrames = (until) =>
    new Promise((done) => {
      const step = () => {
        if (elapsed() >= until) return done();
        draw();
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  await onFrames(phases.rafUntil);
  await new Promise((done) => setTimeout(done, phases.freezeMs));
  await new Promise((done) => {
    const id = setInterval(() => {
      if (elapsed() >= phases.timerUntil) {
        clearInterval(id);
        done();
      } else draw();
    }, 1000 / phases.timerFps);
  });
  await onFrames(phases.endAt);
  recorder.stop();
  await stopped;
  for (const track of stream.getTracks()) track.stop();
  const bytes = new Uint8Array(await new Blob(chunks, { type: recorder.mimeType }).arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  canvas.remove();
  return { recordedMime: recorder.mimeType, base64: btoa(binary), drawn: frame, chunks: chunks.length, ms: Math.round(elapsed()) };
}

const CODEC_NAMES = { av01: 'av1', avc1: 'h264' };

function fileName(browser, recordedMime, timeslice) {
  const [container] = recordedMime.split(';');
  const ext = container === 'video/x-matroska' ? 'mkv' : container === 'video/mp4' ? 'mp4' : 'webm';
  const raw = /codecs=([^,;.]+)/.exec(recordedMime)?.[1] ?? 'default';
  return `rec_${browser}_${CODEC_NAMES[raw] ?? raw}${timeslice ? '_sliced' : ''}.${ext}`;
}

async function supported(page) {
  return page.evaluate((types) => (typeof MediaRecorder === 'undefined' ? null : types.filter((t) => MediaRecorder.isTypeSupported(t.mime)).map((t) => t.label)), TYPES);
}

async function main() {
  const { values, positionals } = parseArgs({
    options: { browsers: { type: 'string', default: 'chromium,webkit' }, list: { type: 'boolean', default: false }, help: { type: 'boolean', default: false } },
    allowPositionals: true,
    strict: true,
  });
  if (values.help) {
    console.log('Usage: node scripts/fixtures/record-mediarecorder.mjs [outDir] [--browsers chromium,webkit,firefox] [--list]');
    return 0;
  }
  const outDir = resolve(positionals[0] ?? join(HERE, '..', '..', 'fixtures', 'files'));
  const names = values.browsers.split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = names.filter((n) => !LAUNCHERS[n]);
  if (unknown.length > 0) {
    console.error(`unknown browser: ${unknown.join(', ')} (known: ${Object.keys(LAUNCHERS).join(', ')})`);
    return 2;
  }
  mkdirSync(outDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  for (const name of names) {
    const browser = await LAUNCHERS[name].launch({ headless: true });
    try {
      const version = browser.version();
      const page = await browser.newPage();
      await page.setContent('<!doctype html><title>recorder</title><body></body>');
      const labels = await supported(page);
      if (values.list) {
        console.log(`${name} ${version}: ${labels === null ? 'no MediaRecorder' : labels.length > 0 ? labels.join(', ') : 'none of the types'}`);
        continue;
      }
      if (!labels || labels.length === 0) {
        console.error(`${name} ${version}: ${labels === null ? 'no MediaRecorder' : 'records none of the types'}, skipped`);
        continue;
      }
      const written = new Set();
      for (const type of TYPES.filter((t) => labels.includes(t.label))) {
        for (const timeslice of [0, SETTINGS.timeslice]) {
          const r = await page.evaluate(recordInPage, { mime: type.mime, timeslice, width: SETTINGS.width, height: SETTINGS.height, bitrate: SETTINGS.bitrate, phases: SETTINGS.phases });
          const file = fileName(name, r.recordedMime, timeslice);
          if (written.has(file)) {
            console.error(`${name}: ${type.mime} records as ${r.recordedMime}, already written as ${file}, skipped`);
            continue;
          }
          written.add(file);
          const bytes = Buffer.from(r.base64, 'base64');
          writeFileSync(join(outDir, file), bytes);
          console.log(
            JSON.stringify({ file, browser: name, version, mime: type.mime, recordedMime: r.recordedMime, timesliceMs: timeslice || null, size: `${SETTINGS.width}x${SETTINGS.height}`, videoBitsPerSecond: SETTINGS.bitrate, drawn: r.drawn, chunks: r.chunks, ms: r.ms, bytes: bytes.length, date }),
          );
        }
      }
    } finally {
      await browser.close();
    }
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
