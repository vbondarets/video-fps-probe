export type Engine = 'own' | 'mp4box' | 'mediabunny' | 'rvfc';
export type Family = 'isobmff' | 'matroska';

export interface BundlerApp {
  name: string;
  path: string;
  engines: Engine[];
}

export interface BundlerStep {
  bin?: string;
  runtime?: string;
  node?: string[];
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface BundlerRunner {
  loader: 'import' | 'require';
  file: string;
}

export interface BundlerTarget {
  name: string;
  group: string;
  tool: string;
  pm: 'npm' | 'pnpm' | 'yarn' | 'bun' | 'deno';
  port: number;
  shared: string[];
  configs: string[];
  sources?: string[];
  snippets?: string[];
  consumers?: string[];
  build: BundlerStep[];
  start?: BundlerStep;
  dev?: BundlerStep;
  out?: string;
  apps?: BundlerApp[];
  split?: boolean;
  route?: string;
  serverOut?: string;
  serverLoads?: 'bundled' | 'external';
  runners?: BundlerRunner[];
  resolved?: Partial<Record<'import' | 'require', string[]>>;
  sharedWithImport?: boolean[];
  peerWarnings?: boolean;
  fails?: {
    build?: string[];
    analyze?: { code: string; reason: string };
    missing?: Record<Family, string>;
  };
}

export const BUNDLERS_PORT: number;
export const UPSTREAM_OFFSET: number;
export const DEV_OFFSET: number;
export const FIRST_MP4_LIMIT: number;
export const SERVER_FILE: string;
export const PARSER_MARKERS: Record<Family, string>;
export const CLIENT_MARKER: string;
export const FORBIDDEN_IN_ZERO_CONFIG: RegExp;
export const CONFIG_NAME: RegExp;
export const TARGETS: BundlerTarget[];
export const GROUPS: string[];
export function targetsOf(only?: string): BundlerTarget[];
export function hasPage(target: BundlerTarget): boolean;
export function appUrl(target: BundlerTarget, app: BundlerApp, dev?: boolean): string;
