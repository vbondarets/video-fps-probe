export interface SnippetPair {
  browser: string;
  node: string;
}

export type FragmentedDurationMode = 'header' | 'index';
export type SizeBasis = 'stored' | 'display';
export type HdrPolicy = 'allow' | 'warn' | 'reject';
export type UrlMode = 'header' | 'full';

export interface LimitValues {
  maxBytes?: number;
  maxReads?: number;
  maxMs?: number;
  maxTracks?: number;
  maxTopLevelBoxes?: number;
}

export interface HeaderSettings {
  limits: LimitValues;
  fragmentedDuration: FragmentedDurationMode;
  color: boolean;
  aspect: boolean;
}

export const LIMIT_KEYS = ['maxBytes', 'maxReads', 'maxMs', 'maxTracks', 'maxTopLevelBoxes'] as const;

export const LIMIT_PRESETS: readonly { id: string; label: string; limits: Required<LimitValues> }[] = [
  { id: 'defaults', label: 'Defaults', limits: { maxBytes: 16 * 1024 * 1024, maxReads: 8, maxMs: 10_000, maxTracks: 64, maxTopLevelBoxes: 1024 } },
  { id: 'tight', label: 'Tight server', limits: { maxBytes: 2 * 1024 * 1024, maxReads: 3, maxMs: 2500, maxTracks: 16, maxTopLevelBoxes: 32 } },
  { id: 'tiny', label: 'Tiny (4 KiB, shows a limit error)', limits: { maxBytes: 4096, maxReads: 2, maxMs: 1000, maxTracks: 4, maxTopLevelBoxes: 8 } },
];

const literal = (n: number): string => (n === Infinity ? 'Infinity' : String(n));

function limitsLine(limits: LimitValues): string | null {
  const set = LIMIT_KEYS.filter((k) => limits[k] !== undefined).map((k) => `${k}: ${literal(limits[k]!)}`);
  return set.length > 0 ? `limits: { ${set.join(', ')} },` : null;
}

function headerOptions(s: HeaderSettings, first: readonly string[]): string {
  const lines = [...first, limitsLine(s.limits), `fragmentedDuration: '${s.fragmentedDuration}',`, s.color ? 'color: true,' : null, s.aspect ? 'aspect: true,' : null].filter((l): l is string => l !== null);
  return lines.map((l) => `    ${l}`).join('\n');
}

const HEADER_RETURN = `  if (result.errorCode) {
    return { ok: false, code: result.errorCode, kind: errorClass(result.errorCode), message: result.error };
  }
  const track = result.videoTracks.find((t) => t.trackId === result.primaryTrackId);
  return {
    ok: true,
    reads: result.io.reads,
    bytesRequested: result.io.bytesRequested,
    layout: result.layout?.kind ?? null,
    hdr: track?.color?.hdr ?? null,
  };`;

export function headerSnippet(s: HeaderSettings): SnippetPair {
  return {
    browser: `import { analyzeHeader, errorClass } from 'video-fps-probe/header';

export async function readHeader(file: File) {
  const result = await analyzeHeader(file, {
${headerOptions(s, [])}
  });
${HEADER_RETURN}
}
`,
    node: `import { openAsBlob } from 'node:fs';
import { analyzeHeader, errorClass } from 'video-fps-probe/header';

export async function readHeader(path: string) {
  const result = await analyzeHeader(await openAsBlob(path), {
${headerOptions(s, ['name: path,'])}
  });
${HEADER_RETURN}
}
`,
  };
}

const TRACK_SUMMARY = `  if (result.errorCode) return { ok: false, code: result.errorCode, message: result.error } as const;
  const track = result.videoTracks.find((t) => t.trackId === result.primaryTrackId);
  return {
    ok: true,
    fps: track?.avgFps?.value ?? null,
    frames: track?.presentedFrames ?? track?.frames ?? null,
    variable: track?.isVfr ?? null,
    medianFrameInterval: track?.medianFrameInterval ?? null,
    enabled: track?.enabled ?? null,
  } as const;`;

export const ANALYZE_SNIPPET: SnippetPair = {
  browser: `import { createProbe } from 'video-fps-probe';

const probe = createProbe();

export async function frameRateOf(file: File) {
  const result = await probe.analyze(file);
${TRACK_SUMMARY}
}
`,
  node: `import { openAsBlob } from 'node:fs';
import { analyze } from 'video-fps-probe';

export async function frameRateOf(path: string) {
  const result = await analyze(await openAsBlob(path), { name: path });
${TRACK_SUMMARY}
}
`,
};

const COLOR_SUMMARY = `  if (result.errorCode) return { ok: false, code: result.errorCode, message: result.error } as const;
  const track = result.videoTracks.find((t) => t.trackId === result.primaryTrackId);
  const color = track?.color;
  return {
    ok: true,
    colorRead: color !== undefined,
    hdr: color?.hdr ?? null,
    dolbyVision: color?.dolbyVision ?? null,
    transfer: color?.transfer ?? null,
    aspectRead: track?.sampleAspectRatio !== undefined,
    sampleAspectRatio: track?.sampleAspectRatio ?? null,
    displayWidth: track?.displayWidth ?? null,
    displayHeight: track?.displayHeight ?? null,
  } as const;`;

export const COLOR_SNIPPET: SnippetPair = {
  browser: `import { createProbe } from 'video-fps-probe';
import { withAspect } from 'video-fps-probe/aspect';
import { withColor } from 'video-fps-probe/color';

const probe = createProbe();

export async function colorAndAspectOf(file: File) {
  const raw = await probe.analyze(file, { codecConfig: true });
  const result = withAspect(withColor(raw, { keepCodecConfig: true }));
${COLOR_SUMMARY}
}
`,
  node: `import { openAsBlob } from 'node:fs';
import { analyze } from 'video-fps-probe';
import { withAspect } from 'video-fps-probe/aspect';
import { withColor } from 'video-fps-probe/color';

export async function colorAndAspectOf(path: string) {
  const raw = await analyze(await openAsBlob(path), { name: path, codecConfig: true });
  const result = withAspect(withColor(raw, { keepCodecConfig: true }));
${COLOR_SUMMARY}
}
`,
};

const URL_IMPORTS: Record<UrlMode, string> = {
  header: `import { analyzeHeader } from 'video-fps-probe/header';
import { httpRange, openRangeSource } from 'video-fps-probe/url';`,
  full: `import { analyze } from 'video-fps-probe';
import { withAspect } from 'video-fps-probe/aspect';
import { withColor } from 'video-fps-probe/color';
import { httpRange, openRangeSource } from 'video-fps-probe/url';`,
};

const URL_TIMEOUT: Record<UrlMode, string> = { header: '10_000', full: '30_000' };

function urlRead(mode: UrlMode, href: string, name: string, indent: string): string {
  const body =
    mode === 'header'
      ? [`const source = await openRangeSource(httpRange(${href}), { signal });`, `return await analyzeHeader(source, { ${name}, signal, color: true, aspect: true });`]
      : [
          `const source = await openRangeSource(httpRange(${href}), { signal });`,
          `const result = await analyze(source, { ${name}, signal, codecConfig: true });`,
          `return withAspect(withColor(result, { keepCodecConfig: true }));`,
        ];
  return body.map((l) => `${indent}${l}`).join('\n');
}

export function urlSnippet(mode: UrlMode): SnippetPair {
  const fn = mode === 'header' ? 'readHeaderFromUrl' : 'analyzeUrl';
  return {
    browser: `${URL_IMPORTS[mode]}

export async function ${fn}(url: string) {
  const name = new URL(url).pathname.split('/').pop() || 'video';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ${URL_TIMEOUT[mode]});
  const signal = controller.signal;
  try {
${urlRead(mode, 'url', 'name', '    ')}
  } finally {
    clearTimeout(timer);
  }
}
`,
    node: `${URL_IMPORTS[mode]}

export async function ${fn}(presignedGetUrl: string, key: string) {
  const signal = AbortSignal.timeout(${URL_TIMEOUT[mode]});
${urlRead(mode, 'presignedGetUrl', 'name: key', '  ')}
}
`,
  };
}

export interface CheckOverrides {
  sizeBasis?: SizeBasis;
  hdr?: HdrPolicy;
}

export function checkSnippet(preset: string | null, overrides: CheckOverrides): SnippetPair {
  const extra = [overrides.sizeBasis ? `sizeBasis: '${overrides.sizeBasis}'` : null, overrides.hdr ? `hdr: '${overrides.hdr}'` : null].filter((x): x is string => x !== null);
  const base = preset ? `${preset}.rules` : 'rules';
  const rules = extra.length > 0 ? `{ ...${base}, ${extra.join(', ')} }` : base;
  const presetImport = preset ? `\nimport { ${preset} } from 'video-fps-probe/presets';` : '';
  const checkImport = preset ? `import { check } from 'video-fps-probe/check';` : `import { check, type CheckRules } from 'video-fps-probe/check';`;
  const load = preset ? '' : `  const rules = (await (await fetch(rulesUrl)).json()) as CheckRules;\n`;
  const args = preset ? '' : ', rulesUrl: string';
  return {
    browser: `import { createProbe } from 'video-fps-probe';
import { withAspect } from 'video-fps-probe/aspect';
${checkImport}
import { withColor } from 'video-fps-probe/color';${presetImport}

const probe = createProbe();

export async function checkUpload(file: File${args}) {
${load}  const result = withAspect(withColor(await probe.analyze(file, { codecConfig: true }), { keepCodecConfig: true }));
  return check(result, ${rules});
}
`,
    node: `import { openAsBlob } from 'node:fs';
import { analyze } from 'video-fps-probe';
import { withAspect } from 'video-fps-probe/aspect';
${checkImport}
import { withColor } from 'video-fps-probe/color';${presetImport}

export async function checkUpload(path: string${args}) {
${load}  const raw = await analyze(await openAsBlob(path), { name: path, codecConfig: true });
  return check(withAspect(withColor(raw, { keepCodecConfig: true })), ${rules});
}
`,
  };
}

const triage = (entry: string) => `import { errorClass, errorCodeOf, warningCodesOf, type FileResult } from '${entry}';

export function triage(result: FileResult) {
  const code = errorCodeOf(result);
  if (code === null) return { status: 'ok', warnings: warningCodesOf(result) } as const;
  const kind = errorClass(code);
  if (kind === 'file') return { status: 'reject', code, cacheable: true } as const;
  if (kind === 'limit') return { status: 'retry with larger limits', code } as const;
  return { status: 'retry later', code } as const;
}
`;

export const ERRORS_SNIPPET: SnippetPair = { browser: triage('video-fps-probe'), node: triage('video-fps-probe/header') };
