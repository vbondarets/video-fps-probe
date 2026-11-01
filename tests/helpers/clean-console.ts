import { test as base, type BrowserContext, type ConsoleMessage, type Page, type Request, type Response, type TestInfo } from '@playwright/test';

export { expect } from '@playwright/test';
export type { Browser, BrowserContext, Locator, Page } from '@playwright/test';

export type BrowserName = 'chromium' | 'firefox' | 'webkit';
export type NoiseKind = 'console' | 'request' | 'page';

export interface Noise {
  kind: NoiseKind;
  text: string;
}

export interface NoiseAllowance {
  browsers: readonly BrowserName[];
  console?: RegExp;
  request?: RegExp;
  reason: string;
}

export type AllowNoise = (allowance: NoiseAllowance) => void;

export const LOUD_CONSOLE_TYPES: readonly string[] = ['warning', 'error', 'assert'];
export const PACKAGE_FILE = /\/node_modules\/(?:\.vite\/deps\/)?video-fps-probe\b|\/video-fps-probe\/dist\/|\/(?:own|own-isobmff|own-matroska|mp4box|mediabunny|probe)\.worker\b/;
export const WATCHED_REQUEST_TYPES: readonly string[] = ['script', 'fetch', 'xhr'];

const REJECTIONS = '__rejections';
const SCRIPT_PATH = /\.m?js$/;

function recordRejections(key: string): void {
  const store = ((window as unknown as Record<string, unknown>)[key] ??= []) as string[];
  window.addEventListener('unhandledrejection', (event) => {
    const reason: unknown = event.reason;
    store.push(reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason));
  });
}

const where = (m: ConsoleMessage): string => (m.worker() ? `worker ${m.worker()!.url()}` : `page ${m.page()?.url() ?? ''}`);

function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

export class NoiseCollector {
  readonly noise: Noise[] = [];
  readonly #origins = new Set<string>();
  readonly #pages = new Set<Page>();
  readonly #contexts = new WeakSet<BrowserContext>();
  #frozen = false;

  add(kind: NoiseKind, text: string): void {
    if (!this.#frozen) this.noise.push({ kind, text });
  }

  async attachContext(context: BrowserContext): Promise<void> {
    if (this.#contexts.has(context)) return;
    this.#contexts.add(context);
    await context.addInitScript(recordRejections, REJECTIONS);
    context.on('page', (page) => this.attachPage(page));
    for (const page of context.pages()) this.attachPage(page);
    context.on('console', (m) => this.#onConsole(m));
    context.on('weberror', (e) => this.add('page', `page error ${e.error().name}: ${e.error().message}`));
    context.on('requestfailed', (r) => {
      if (this.#watched(r)) this.add('request', `request failed ${r.method()} ${r.url()}: ${r.failure()?.errorText ?? 'unknown error'}`);
    });
    context.on('response', (r) => this.#onResponse(r));
  }

  attachPage(page: Page): void {
    if (this.#pages.has(page)) return;
    this.#pages.add(page);
    const note = (url: string) => {
      const origin = originOf(url);
      if (origin) this.#origins.add(origin);
    };
    note(page.url());
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) note(frame.url());
    });
    page.on('request', (r) => {
      if (r.isNavigationRequest() && r.frame() === page.mainFrame()) note(r.url());
    });
    page.on('crash', () => this.add('page', `page crashed: ${page.url()}`));
  }

  async collectRejections(): Promise<void> {
    for (const page of this.#pages) {
      if (page.isClosed()) continue;
      const reasons = await page.evaluate((key) => [...(((window as unknown as Record<string, unknown>)[key] as string[] | undefined) ?? [])], REJECTIONS).catch(() => [] as string[]);
      for (const reason of reasons) this.add('page', `unhandled rejection in ${page.url()}: ${reason}`);
    }
  }

  async finish(): Promise<Noise[]> {
    await this.collectRejections();
    this.#frozen = true;
    return this.noise;
  }

  #onConsole(m: ConsoleMessage): void {
    const { url, lineNumber } = m.location();
    if (!LOUD_CONSOLE_TYPES.includes(m.type()) && !PACKAGE_FILE.test(url)) return;
    this.add('console', `console ${m.type()} in ${where(m)}: ${m.text()}${url ? ` (${url}:${lineNumber})` : ''}`);
  }

  #onResponse(r: Response): void {
    if (r.status() >= 400 && this.#watched(r.request())) this.add('request', `request ${r.status()} ${r.request().method()} ${r.url()}`);
  }

  #watched(r: Request): boolean {
    const origin = originOf(r.url());
    if (!origin || !this.#origins.has(origin)) return false;
    return WATCHED_REQUEST_TYPES.includes(r.resourceType()) || SCRIPT_PATH.test(new URL(r.url()).pathname);
  }
}

interface Allowance extends NoiseAllowance {
  matched: Set<'console' | 'request'>;
}

export class NoiseGuard {
  readonly collector = new NoiseCollector();
  readonly #allowances: Allowance[] = [];
  readonly browser: BrowserName;

  constructor(browser: BrowserName) {
    this.browser = browser;
  }

  allow(allowance: NoiseAllowance): void {
    if (!allowance.reason.trim()) throw new Error('allowNoise needs a reason');
    if (!allowance.console && !allowance.request) throw new Error(`allowNoise (${allowance.reason}) names neither console nor request noise`);
    if (allowance.browsers.length === 0) throw new Error(`allowNoise (${allowance.reason}) names no browser`);
    this.#allowances.push({ ...allowance, matched: new Set() });
  }

  async verify(): Promise<string[]> {
    const noise = await this.collector.finish();
    const active = this.#allowances.filter((a) => a.browsers.includes(this.browser));
    const left = noise.filter((n) => {
      const kind = n.kind;
      if (kind === 'page') return true;
      const by = active.filter((a) => a[kind]?.test(n.text));
      for (const a of by) a.matched.add(kind);
      return by.length === 0;
    });
    const problems = left.map((n) => n.text);
    for (const a of active) {
      for (const kind of ['console', 'request'] as const) {
        if (a[kind] && !a.matched.has(kind)) problems.push(`unused ${kind} allowance in ${this.browser}: ${a[kind]} (${a.reason})`);
      }
    }
    return problems;
  }
}

let current: NoiseGuard | null = null;

export async function watch(page: Page): Promise<NoiseCollector> {
  const collector = current?.collector ?? new NoiseCollector();
  await collector.attachContext(page.context());
  return collector;
}

async function guarded(browser: BrowserName, provide: (guard: NoiseGuard) => Promise<void>, info: TestInfo): Promise<void> {
  const guard = new NoiseGuard(browser);
  current = guard;
  try {
    await provide(guard);
  } finally {
    current = null;
  }
  if (info.status === 'skipped') return;
  const problems = await guard.verify();
  if (problems.length > 0) throw new Error(`the console, the page and the network were not clean:\n${problems.map((p) => `  ${p}`).join('\n')}`);
}

export const test = base.extend<{ noiseGuard: NoiseGuard; allowNoise: AllowNoise }>({
  noiseGuard: [async ({ browserName }, provide, info) => guarded(browserName as BrowserName, provide, info), { auto: true }],
  context: async ({ context, noiseGuard }, provide) => {
    await noiseGuard.collector.attachContext(context);
    await provide(context);
    await noiseGuard.collector.finish();
  },
  allowNoise: async ({ noiseGuard }, provide) => {
    await provide((allowance) => noiseGuard.allow(allowance));
  },
});
