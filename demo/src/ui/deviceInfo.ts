/// <reference types="vite/client" />
import { version } from '../../../package.json';
import type { FileResult, MatroskaMode } from 'video-fps-probe';


export const EXPORT_SCHEMA = 'video-fps-probe/export@1';
export const EXPORT_FILE_NAME = 'video-fps-probe-results.json';

export interface HighEntropy {
  platformVersion: string | null;
  model: string | null;
  architecture: string | null;
  bitness: string | null;
}

export interface UserAgentDataLike {
  brands?: readonly { brand: string; version: string }[];
  mobile?: boolean;
  platform?: string;
  getHighEntropyValues?(hints: string[]): Promise<Record<string, unknown>>;
}

export interface EnvironmentGlobals {
  navigator: {
    userAgent: string;
    userAgentData?: UserAgentDataLike;
    platform?: string;
    language?: string;
    hardwareConcurrency?: number;
    deviceMemory?: number;
    maxTouchPoints?: number;
  };
  screen?: { width: number; height: number };
  innerWidth?: number;
  innerHeight?: number;
  devicePixelRatio?: number;
  crossOriginIsolated?: boolean;
}

export interface Environment {
  userAgent: string;
  userAgentData: {
    brands: { brand: string; version: string }[];
    mobile: boolean | null;
    platform: string | null;
    platformVersion: string | null;
    model: string | null;
    architecture: string | null;
    bitness: string | null;
  } | null;
  platform: string | null;
  language: string | null;
  hardwareConcurrency: number | null;
  deviceMemory: number | null;
  maxTouchPoints: number | null;
  screen: { width: number; height: number; devicePixelRatio: number } | null;
  viewport: { width: number; height: number } | null;
  timezone: string | null;
  crossOriginIsolated: boolean | null;
  timestamp: string;
}

export interface ExportRow {
  result: FileResult | null;
  compare: Readonly<Record<string, { result: FileResult | null } | undefined>>;
}

export interface ExportSettings {
  matroskaMode: MatroskaMode;
}

export interface ExportDocument {
  schema: string;
  app: { name: string; version: string; build: string | null; buildTime: string | null; commit: string | null };
  environment: Environment;
  settings: ExportSettings;
  results: (FileResult & { compare?: Record<string, FileResult> })[];
}

export type ExportAction = 'download' | 'copy';

export interface ExportOutcome {
  ok: boolean;
  message: string;
  text: string | null;
}

const HIGH_ENTROPY_HINTS = ['platformVersion', 'model', 'architecture', 'bitness'];
const GREASE_BRAND = /^not.{1,3}a.{1,3}brand$/i;
const UA_BROWSERS: readonly (readonly [string, RegExp])[] = [
  ['Edge', /\bEdg(?:A|iOS)?\/(\d+)/],
  ['Opera', /\bOPR\/(\d+)/],
  ['Samsung Internet', /\bSamsungBrowser\/(\d+)/],
  ['Firefox', /\b(?:Firefox|FxiOS)\/(\d+)/],
  ['Chrome', /(?:Chrome|CriOS)\/(\d+)/],
  ['Safari', /\bVersion\/(\d+(?:\.\d+)?)\b.*\bSafari\//],
];

let knownHighEntropy: HighEntropy | null = null;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const major = (v: string): number => parseInt(v, 10);

function timezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

export async function readHighEntropy(nav: EnvironmentGlobals['navigator']): Promise<HighEntropy | null> {
  const data = nav.userAgentData;
  if (!data?.getHighEntropyValues) return null;
  try {
    const v = await data.getHighEntropyValues(HIGH_ENTROPY_HINTS);
    return { platformVersion: str(v.platformVersion), model: str(v.model), architecture: str(v.architecture), bitness: str(v.bitness) };
  } catch {
    return null;
  }
}

export function collectEnvironment(
  g: EnvironmentGlobals = globalThis,
  now: Date = new Date(),
  highEntropy: HighEntropy | null = knownHighEntropy,
): Environment {
  const nav = g.navigator;
  const data = nav.userAgentData;
  const width = num(g.screen?.width);
  const height = num(g.screen?.height);
  const innerWidth = num(g.innerWidth);
  const innerHeight = num(g.innerHeight);
  return {
    userAgent: nav.userAgent,
    userAgentData: data
      ? {
          brands: (data.brands ?? []).map(({ brand, version: v }) => ({ brand, version: v })),
          mobile: typeof data.mobile === 'boolean' ? data.mobile : null,
          platform: str(data.platform),
          platformVersion: highEntropy?.platformVersion ?? null,
          model: highEntropy?.model ?? null,
          architecture: highEntropy?.architecture ?? null,
          bitness: highEntropy?.bitness ?? null,
        }
      : null,
    platform: str(nav.platform),
    language: str(nav.language),
    hardwareConcurrency: num(nav.hardwareConcurrency),
    deviceMemory: num(nav.deviceMemory),
    maxTouchPoints: num(nav.maxTouchPoints),
    screen: width !== null && height !== null ? { width, height, devicePixelRatio: num(g.devicePixelRatio) ?? 1 } : null,
    viewport: innerWidth !== null && innerHeight !== null ? { width: innerWidth, height: innerHeight } : null,
    timezone: timezone(),
    crossOriginIsolated: typeof g.crossOriginIsolated === 'boolean' ? g.crossOriginIsolated : null,
    timestamp: now.toISOString(),
  };
}

function browserOf(env: Environment): string {
  const real = (env.userAgentData?.brands ?? []).filter((b) => !GREASE_BRAND.test(b.brand));
  const brand = real.find((b) => b.brand !== 'Chromium') ?? real[0];
  if (brand) return `${brand.brand.replace(/^(?:Google|Microsoft) /, '')} ${major(brand.version)}`;
  for (const [name, re] of UA_BROWSERS) {
    const m = re.exec(env.userAgent);
    if (m) return `${name} ${m[1]}`;
  }
  return 'Unknown browser';
}

function osOf(env: Environment): string | null {
  const ua = env.userAgent;
  const pv = env.userAgentData?.platformVersion || null;
  let m: RegExpExecArray | null;
  if ((m = /\b(?:iPhone|iPod)\b.*? OS (\d+)[_.](\d+)/.exec(ua))) return `iOS ${m[1]}.${m[2]}`;
  if ((m = /\biPad\b.*? OS (\d+)[_.](\d+)/.exec(ua))) return `iPadOS ${m[1]}.${m[2]}`;
  if (/\bMacintosh\b/.test(ua) && (env.maxTouchPoints ?? 0) > 1) return 'iPadOS';
  if (/\bAndroid\b/.test(ua)) {
    if (pv) return `Android ${major(pv)}`;
    m = /\bAndroid (\d+(?:\.\d+)?)/.exec(ua);
    return m && !/\bAndroid 10; K\b/.test(ua) ? `Android ${m[1]}` : 'Android';
  }
  if (/\bWindows\b/.test(ua)) return pv ? (major(pv) >= 13 ? 'Windows 11' : 'Windows 10') : 'Windows';
  if (/\bCrOS\b/.test(ua)) return 'ChromeOS';
  if (/\bMac OS X\b/.test(ua)) return pv ? `macOS ${pv.split('.').slice(0, 2).join('.')}` : 'macOS';
  if (/\bLinux\b|\bX11\b/.test(ua)) return 'Linux';
  return env.userAgentData?.platform || env.platform || null;
}

export function describeEnvironment(env: Environment): string {
  const os = osOf(env);
  const model = env.userAgentData?.model;
  const parts = [`${browserOf(env)}${os ? ` on ${os}` : ''}${model ? ` (${model})` : ''}`];
  const threads = env.hardwareConcurrency;
  if (threads !== null) parts.push(`${threads} thread${threads === 1 ? '' : 's'}`);
  if (env.screen) parts.push(`${env.screen.width}x${env.screen.height} @${+env.screen.devicePixelRatio.toFixed(2)}x`);
  return parts.join(', ');
}

export function watchEnvironmentLine(onLine: (line: string) => void): void {
  onLine(describeEnvironment(collectEnvironment()));
  void readHighEntropy(navigator).then((high) => {
    if (!high) return;
    knownHighEntropy = high;
    onLine(describeEnvironment(collectEnvironment()));
  });
}

export function entryChunk(): string | null {
  if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return null;
  const src = document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.src;
  return src ? (src.split('/').pop()?.split('?')[0] ?? null) : null;
}

export function buildMeta(name: 'build-time' | 'build-commit'): string | null {
  if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return null;
  return document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content || null;
}

export function buildExport(rows: readonly ExportRow[], settings: ExportSettings, env: Environment): ExportDocument {
  const results = rows.flatMap((row) => {
    if (!row.result) return [];
    const compare: Record<string, FileResult> = {};
    for (const [engine, run] of Object.entries(row.compare)) if (run?.result) compare[engine] = run.result;
    return [Object.keys(compare).length > 0 ? { ...row.result, compare } : row.result];
  });
  return {
    schema: EXPORT_SCHEMA,
    app: {
      name: 'video-fps-probe',
      version,
      build: entryChunk(),
      buildTime: buildMeta('build-time'),
      commit: buildMeta('build-commit'),
    },
    environment: env,
    settings: { matroskaMode: settings.matroskaMode },
    results,
  };
}

function saveText(text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: EXPORT_FILE_NAME });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function copyWithSelection(text: string): boolean {
  const area = Object.assign(document.createElement('textarea'), { value: text, readOnly: true });
  area.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.append(area);
  area.select();
  area.setSelectionRange(0, text.length);
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  area.remove();
  return copied;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return copyWithSelection(text);
  }
}

export function exportResults(rows: readonly ExportRow[], settings: ExportSettings, action: ExportAction): Promise<ExportOutcome> {
  const doc = buildExport(rows, settings, collectEnvironment());
  const text = JSON.stringify(doc, null, 2);
  const n = doc.results.length;
  const what = `${n} result${n === 1 ? '' : 's'}`;
  if (action === 'download') {
    saveText(text);
    return Promise.resolve({ ok: true, message: `Saved ${what} as ${EXPORT_FILE_NAME}.`, text: null });
  }
  return copyText(text).then((copied) =>
    copied
      ? { ok: true, message: `Copied ${what} to the clipboard.`, text: null }
      : { ok: false, message: 'The browser blocked copying. Select the text below and copy it by hand, or use Download JSON.', text },
  );
}
