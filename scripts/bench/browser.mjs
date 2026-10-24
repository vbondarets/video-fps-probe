import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { delimiter, join } from 'node:path';

const KNOWN = {
  chrome: {
    win32: [
      ['ProgramFiles', 'Google/Chrome/Application/chrome.exe'],
      ['ProgramFiles(x86)', 'Google/Chrome/Application/chrome.exe'],
      ['LOCALAPPDATA', 'Google/Chrome/Application/chrome.exe'],
    ],
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    linux: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'],
  },
  edge: {
    win32: [
      ['ProgramFiles(x86)', 'Microsoft/Edge/Application/msedge.exe'],
      ['ProgramFiles', 'Microsoft/Edge/Application/msedge.exe'],
      ['LOCALAPPDATA', 'Microsoft/Edge/Application/msedge.exe'],
    ],
    darwin: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
    linux: ['microsoft-edge', 'microsoft-edge-stable'],
  },
};

function onPath(name) {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
}

export function findBrowser(kind, env = process.env, platform = process.platform) {
  if (kind === 'chrome' && env.CHROME_PATH) return existsSync(env.CHROME_PATH) ? env.CHROME_PATH : null;
  if (kind === 'edge' && env.EDGE_PATH) return existsSync(env.EDGE_PATH) ? env.EDGE_PATH : null;
  for (const c of KNOWN[kind][platform] ?? KNOWN[kind].linux) {
    if (Array.isArray(c)) {
      const base = env[c[0]];
      if (base && existsSync(join(base, c[1]))) return join(base, c[1]);
    } else if (c.startsWith('/')) {
      if (existsSync(c)) return c;
    } else {
      const p = onPath(c);
      if (p) return p;
    }
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Connection {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Set();
    ws.onmessage = (ev) => {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
      if (m.id !== undefined) {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}${m.error.data ? ` (${m.error.data})` : ''}`));
        else p.resolve(m.result);
      } else {
        for (const h of this.handlers) h(m);
      }
    };
    ws.onclose = () => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(`${p.method}: connection closed`));
      }
      this.pending.clear();
    };
  }

  static open(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => resolve(new Connection(ws));
      ws.onerror = () => reject(new Error(`cannot connect to ${url}`));
    });
  }

  send(method, params = {}, sessionId = undefined, timeoutMs = 120_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no answer in ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      return;
    }
  }
}

export class Session {
  constructor(conn, sessionId) {
    this.conn = conn;
    this.sessionId = sessionId;
  }

  send(method, params = {}, timeoutMs = 120_000) {
    return this.conn.send(method, params, this.sessionId, timeoutMs);
  }

  waitFor(method, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.conn.handlers.delete(h);
        reject(new Error(`${method}: not received in ${timeoutMs} ms`));
      }, timeoutMs);
      const h = (m) => {
        if (m.method !== method || m.sessionId !== this.sessionId) return;
        clearTimeout(timer);
        this.conn.handlers.delete(h);
        resolve(m.params);
      };
      this.conn.handlers.add(h);
    });
  }

  async eval(expression, timeoutMs = 120_000) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, timeoutMs);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`page: ${d.exception?.description ?? d.exception?.value ?? d.text}`);
    }
    return r.result.value;
  }

  async handle(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: false });
    if (r.exceptionDetails || !r.result.objectId) throw new Error(`page: no object for ${expression}`);
    return r.result.objectId;
  }
}

const live = new Set();

function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      return;
    }
  }
}

export function killAllBrowsers() {
  for (const b of live) killTree(b.child);
}

function exited(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function removeDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    return true;
  } catch {
    return false;
  }
}

export async function launchBrowser({ exe, profileDir, args = [], width = 1280, height = 900 }) {
  removeDir(profileDir);
  mkdirSync(profileDir, { recursive: true });
  const flags = [
    '--headless=new',
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    `--user-data-dir=${profileDir}`,
    `--window-size=${width},${height}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-extensions',
    '--disable-default-apps',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--hide-scrollbars',
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    ...args,
    ...(process.env.BENCH_BROWSER_FLAGS ?? '').split(/s+/).filter(Boolean),
    'about:blank',
  ];
  const child = spawn(exe, flags, { stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32' });
  const handle = { child, profileDir };
  live.add(handle);
  try {
    const portFile = join(profileDir, 'DevToolsActivePort');
    let wsUrl = null;
    for (let i = 0; i < 150 && !wsUrl; i++) {
      if (child.exitCode !== null) throw new Error(`${exe} exited with code ${child.exitCode}`);
      if (existsSync(portFile)) {
        const [port, path] = readFileSync(portFile, 'utf8').split(/\r?\n/);
        if (port && path) wsUrl = `ws://127.0.0.1:${port}${path}`;
      }
      if (!wsUrl) await sleep(100);
    }
    if (!wsUrl) throw new Error(`${exe} did not open a DevTools port`);
    const conn = await Connection.open(wsUrl);
    const version = await conn.send('Browser.getVersion');
    const { targetInfos } = await conn.send('Target.getTargets');
    let target = targetInfos.find((t) => t.type === 'page');
    if (!target) target = { targetId: (await conn.send('Target.createTarget', { url: 'about:blank' })).targetId };
    const { sessionId } = await conn.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    const page = new Session(conn, sessionId);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    return {
      version,
      page,
      pid: child.pid,
      browser: new Session(conn, undefined),
      async close() {
        try {
          await conn.send('Browser.close', {}, undefined, 5000);
        } catch {
          conn.close();
        }
        if (!(await exited(child, 5000))) killTree(child);
        await exited(child, 5000);
        live.delete(handle);
        removeDir(profileDir);
      },
    };
  } catch (e) {
    killTree(child);
    await exited(child, 5000);
    live.delete(handle);
    removeDir(profileDir);
    throw e;
  }
}
