import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SHOT_FILES = [
  'cfr_h264_29.97.mp4',
  'vfr_concat_10_30_60.mp4',
  'cfr_vp9_59.94.webm',
  'h264.mkv',
  'mov_prores.mov',
  'fmp4_cmaf.mp4',
  'av_h264_aac.mp4',
  'corrupt_png_named.mp4',
];

export const SHOT_COMPARE_FILE = 'vfr_concat_10_30_60.mp4';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pngSize(buf) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export async function takeScreenshots({ page, app, pathOf, dir, maxHeight = 2400 }) {
  mkdirSync(dir, { recursive: true });
  const shots = [];
  const metrics = (width, height, mobile, deviceScaleFactor) =>
    page.send('Emulation.setDeviceMetricsOverride', { width, height, mobile, deviceScaleFactor, screenWidth: width, screenHeight: height });
  const scheme = (value) => page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value }] });
  const settle = () => page.eval('document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))))');
  const capture = async (name, clip, note) => {
    await settle();
    const { data } = await page.send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 }, captureBeyondViewport: true });
    const buf = Buffer.from(data, 'base64');
    writeFileSync(join(dir, name), buf);
    shots.push({ file: name, bytes: buf.length, ...pngSize(buf), note });
  };
  const pageClip = async (width) => {
    const h = await page.eval('Math.ceil(document.documentElement.scrollHeight)');
    return { x: 0, y: 0, width, height: Math.min(h, maxHeight) };
  };

  try {
    await metrics(1280, 900, false, 1);
    await scheme('light');
    await app.open();
    await app.addFiles(SHOT_FILES.map(pathOf));
    await page.eval('window.scrollTo(0, 0)');
    await capture('app-light.png', await pageClip(1280), `${SHOT_FILES.length} results, light theme, 1280 px`);

    await scheme('dark');
    await capture('app-dark.png', await pageClip(1280), `same list, prefers-color-scheme: dark, 1280 px`);

    await scheme('light');
    await metrics(390, 844, true, 2);
    const firstCard = `document.querySelector('article.card')`;
    await page.eval(`(() => { ${firstCard}.querySelector('details.cmp > summary').click(); return true; })()`);
    const firstStatuses = `(() => { const row = ${firstCard}.querySelector('.cmp-body tbody tr'); return row ? [...row.querySelectorAll('td')].map((td) => td.textContent) : null; })()`;
    for (const end = Date.now() + 60_000; Date.now() < end; await sleep(100)) {
      const st = await page.eval(firstStatuses);
      if (st && st.length >= 3 && st.slice(1, -1).every((x) => x !== 'not run' && x !== 'running' && !/%$/.test(x))) break;
    }
    const top = await page.eval(`(() => { const r = ${firstCard}.querySelector('details.cmp').getBoundingClientRect(); return Math.max(0, Math.round(r.top + scrollY - 420)); })()`);
    await page.eval(`window.scrollTo(0, ${top})`);
    await capture('app-mobile.png', { x: 0, y: top, width: 390, height: 844 }, 'first card at 390 px with the Compare panel open, no sideways scroll (device pixel ratio 2)');
    await page.eval(`(() => { ${firstCard}.querySelector('details.cmp').open = false; window.scrollTo(0, 0); return true; })()`);

    await metrics(1280, 900, false, 1);
    const card = `[...document.querySelectorAll('article.card')].find((c) => c.querySelector('h3').textContent === ${JSON.stringify(SHOT_COMPARE_FILE)})`;
    await page.eval(`(() => { const c = ${card}; c.scrollIntoView({ block: 'start' }); c.querySelector('details.cmp > summary').click(); return true; })()`);
    const statuses = `(() => { const c = ${card}; const row = c.querySelector('.cmp-body tbody tr'); return row ? [...row.querySelectorAll('td')].map((td) => td.textContent) : null; })()`;
    const waitStatus = async (ok, timeoutMs) => {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        const s = await page.eval(statuses);
        if (s && ok(s)) return s;
        await sleep(100);
      }
      throw new Error(`compare panel did not settle: ${JSON.stringify(await page.eval(statuses))}`);
    };
    const finished = (x) => x !== 'not run' && x !== 'running' && !/%$/.test(x);
    const settled = (s) => s.length >= 3 && s.slice(1, -1).every(finished);
    await waitStatus(settled, 60_000);
    await page.eval(`(() => { const c = ${card}; const b = [...c.querySelectorAll('.cmp-body th button')].find((x) => x.textContent.includes('approximate')); b.click(); return true; })()`);
    await sleep(200);
    const final = await waitStatus((s) => finished(s[s.length - 1]), 120_000);
    await page.eval(`(() => { const c = ${card}; c.scrollIntoView({ block: 'start' }); return true; })()`);
    const rect = await page.eval(`(() => { const r = (${card}).getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height }; })()`);
    const pad = 12;
    await capture(
      'compare-vfr.png',
      { x: Math.max(0, Math.floor(rect.x - pad)), y: Math.max(0, Math.floor(rect.y - pad)), width: Math.ceil(rect.width + 2 * pad), height: Math.ceil(rect.height + 2 * pad) },
      `compare panel on ${SHOT_COMPARE_FILE} (statuses: ${final.slice(1).join(', ')})`,
    );
  } finally {
    await page.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
    await page.send('Emulation.setEmulatedMedia', { features: [] }).catch(() => {});
  }
  return shots;
}
