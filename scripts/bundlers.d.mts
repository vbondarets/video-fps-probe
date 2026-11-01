export interface LogEntry {
  seq: number;
  token: string | null;
  method: string;
  path: string;
  status: number;
  js: boolean;
  prefetch: boolean;
  bytes: number;
  gzip: number;
  holds: Array<'isobmff' | 'matroska'>;
  client: boolean;
}

export function versions(): { runtimes: Record<string, string>; packages: Record<string, string> };
export function bundlersDir(arg?: string): string;
export function targetDir(dir: string, target: { name: string }): string;
export function baselineDir(dir: string): string;
export function measureDir(dir: string, target: { name: string }): string;
export function tarballInfo(dir: string): { file: string | null; version: string; source: string };
export function toolEnv(dir: string, extra?: Record<string, string>): NodeJS.ProcessEnv;
export function runtimeVersion(name: string): string | null;
export function latestManifest(root: string, target: { pm: string }, lookup: (name: string, kind: 'runtime' | 'package') => string | null): { manifest: Record<string, unknown> | null; resolved: Record<string, string | null> };
export function lockfileChanges(pm: string, before: string | null, after: string): string[];
export function peerWarnings(pm: string, output: string): string[];
export function peerCheckIssues(pm: 'pnpm' | 'yarn', stdout: string, status: number | null): string[];
export function compareReports(committed: unknown, measured: unknown): string[];
export function checkPins(): string[];
export function fixtureFileProblems(target: { name: string; configs: string[]; sources?: string[]; snippets?: string[] }, files: Array<{ path: string; text: string }>): string[];
export function zeroConfigSourceProblems(target: { name: string }, path: string, text: string): string[];
export function zeroConfigManifestProblems(target: { name: string }, manifest: Record<string, unknown>): string[];
export function checkDocs(): string[];
export function docVersionProblems(docs: string, versions: { runtimes: Record<string, string>; packages: Record<string, string> }): string[];
