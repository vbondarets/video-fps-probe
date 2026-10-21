const PROBE = `(() => {
  const b = { t0: 0, waiter: null };
  addEventListener('change', (e) => {
    if (e.target && e.target.matches && e.target.matches('input[type=file]')) b.t0 = performance.now();
  }, true);
  const probe = () => window.__fpsProbe;
  const copy = (v) => JSON.parse(JSON.stringify(v));
  b.clear = () => {
    const btn = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Clear list');
    if (btn && !btn.disabled) btn.click();
    return probe().results.length;
  };
  b.arm = (expected, timeoutMs, clear) => {
    if (clear) b.clear();
    const n = probe().results.length + expected;
    b.t0 = 0;
    b.waiter = new Promise((resolve, reject) => {
      let finished = false;
      const done = () => { const p = probe(); return !!p && b.t0 > 0 && p.pending === 0 && p.results.length >= n; };
      const end = (ok) => {
        if (finished) return;
        finished = true;
        obs.disconnect();
        clearInterval(iv);
        clearTimeout(to);
        if (ok) resolve({ t0: b.t0, t1: performance.now() });
        else reject(new Error('timeout after ' + timeoutMs + ' ms: pending=' + (probe() ? probe().pending : '?') + ' results=' + (probe() ? probe().results.length : '?') + '/' + n));
      };
      const obs = new MutationObserver(() => { if (done()) end(true); });
      obs.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
      const iv = setInterval(() => { if (done()) end(true); }, 25);
      const to = setTimeout(() => end(false), timeoutMs);
    });
    b.waiter.catch(() => {});
    return n;
  };
  b.wait = async () => { const r = await b.waiter; return { wallMs: r.t1 - r.t0, results: copy(probe().results) }; };
  b.engine = async (index, engine) => {
    const t0 = performance.now();
    try {
      const result = await probe().runEngine(index, engine);
      return { wallMs: performance.now() - t0, result: copy(result), threw: null };
    } catch (e) {
      return { wallMs: performance.now() - t0, result: null, threw: String(e && e.message ? e.message : e) };
    }
  };
  b.hz = () => new Promise((resolve) => {
    let n = 0;
    const t0 = performance.now();
    const tick = () => { n++; const ms = performance.now() - t0; if (ms < 1000) requestAnimationFrame(tick); else resolve((n * 1000) / ms); };
    requestAnimationFrame(tick);
    setTimeout(() => resolve(0), 3000);
  });
  b.resolution = () => {
    let best = Infinity;
    let prev = performance.now();
    const end = prev + 50;
    while (prev < end) {
      const t = performance.now();
      if (t > prev) {
        best = Math.min(best, t - prev);
        prev = t;
      }
    }
    return best;
  };
  window.__bench = b;
})();`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class AppPage {
  constructor(page, url) {
    this.page = page;
    this.url = url;
    this.installed = false;
  }

  async open() {
    if (!this.installed) {
      await this.page.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });
      this.installed = true;
    }
    const loaded = this.page.waitFor('Page.loadEventFired', 60_000);
    const nav = await this.page.send('Page.navigate', { url: this.url });
    if (nav.errorText) throw new Error(`navigation failed: ${nav.errorText}`);
    await loaded;
    for (let i = 0; i < 400; i++) {
      if (await this.page.eval(`!!window.__fpsProbe && !!window.__bench && !!document.querySelector('input[data-testid="file-input"]')`)) {
        return this.page.eval(`(() => {
          const n = performance.getEntriesByType('navigation')[0];
          const res = performance.getEntriesByType('resource').map((e) => ({ path: e.name.replace(location.origin, ''), ms: e.duration, bytes: e.encodedBodySize }));
          return { domContentLoadedMs: n ? n.domContentLoadedEventEnd : null, loadMs: n ? n.loadEventEnd : null, readyMs: performance.now(), resources: res };
        })()`);
      }
      await sleep(25);
    }
    throw new Error('app did not start: window.__fpsProbe or the file input is missing');
  }

  clear() {
    return this.page.eval('window.__bench.clear()');
  }

  async addFiles(paths, { clear = false, expected, timeoutMs = 120_000 } = {}) {
    await this.page.eval(`window.__bench.arm(${expected ?? paths.length}, ${timeoutMs}, ${clear})`);
    const objectId = await this.page.handle(`document.querySelector('input[data-testid="file-input"]')`);
    try {
      await this.page.send('DOM.setFileInputFiles', { files: paths, objectId });
    } finally {
      await this.page.send('Runtime.releaseObject', { objectId }).catch(() => {});
    }
    return this.page.eval('window.__bench.wait()', timeoutMs + 10_000);
  }

  engine(index, engine, timeoutMs = 300_000) {
    return this.page.eval(`window.__bench.engine(${index}, ${JSON.stringify(engine)})`, timeoutMs);
  }

  hz() {
    return this.page.eval('window.__bench.hz()', 10_000);
  }

  timerResolution() {
    return this.page.eval('window.__bench.resolution()');
  }
}
