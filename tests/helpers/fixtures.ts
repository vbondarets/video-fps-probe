import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FIXTURES_DIR = join(REPO_ROOT, 'fixtures');
export const FILES_DIR = join(FIXTURES_DIR, 'files');
export const LARGE_DIR = join(FIXTURES_DIR, 'large');
export const REF_DIR = join(FIXTURES_DIR, 'ref');
export const MANIFEST_PATH = join(FIXTURES_DIR, 'manifest.tsv');

export const MANIFEST_COLUMNS = ['name', 'container', 'category', 'expect', 'committed', 'notes'] as const;

export interface ManifestEntry {
  name: string;
  container: string;
  category: string;
  expect: string;
  committed: boolean;
  notes: string;
  columns: Record<string, string>;
}

export interface RefPacketStats {
  packets: number;
  keyframes?: number;
  discardedPackets?: number;
  ms?: number;
  code?: number | null;
  ptsDeltaMinTicks?: number;
  ptsDeltaMaxTicks?: number;
  distinctDeltas?: number;
  minInstFps?: number | null;
  maxInstFps?: number | null;
  zeroDeltas?: number;
  ptsFirstSec?: number;
  ptsLastSec?: number;
  avgFpsFromPts?: number;
  avgFpsFromSpan?: number;
  durMinTicks?: number | null;
  durMaxTicks?: number | null;
  vfrByDeltaRatio?: boolean;
  minInstFpsByDur?: number;
  maxInstFpsByDur?: number;
  minInstFpsByDts?: number;
  maxInstFpsByDts?: number;
  [key: string]: unknown;
}

export interface RefVideoStream {
  index: number;
  codec_name: string;
  profile?: string;
  codec_tag_string?: string;
  width: number;
  height: number;
  avg_frame_rate: string;
  r_frame_rate: string;
  avg_fps: number | null;
  r_fps: number | null;
  nb_frames: string | null;
  nb_read_frames: string | null;
  duration: string | null;
  start_time: string | null;
  time_base: string;
  has_b_frames?: number;
  packets?: RefPacketStats;
  [key: string]: unknown;
}

export interface RefStreamSummary {
  index: number;
  codec_type: string;
  codec_name?: string;
  attachedPic: boolean;
  [key: string]: unknown;
}

export interface RefFormat {
  format_name: string;
  duration?: string;
  size?: string;
  bit_rate?: string;
  nb_streams?: number;
  start_time?: string;
  [key: string]: unknown;
}

export interface FixtureRef {
  file: string;
  bytes: number;
  ok: boolean;
  probeExit?: number | null;
  probeErr?: string | null;
  probeMs?: number;
  countFramesMs?: number;
  ffprobeVersion?: string;
  format?: RefFormat;
  streams?: RefStreamSummary[];
  videos?: RefVideoStream[];
  [key: string]: unknown;
}

function parseBool(v: string | undefined): boolean {
  return /^(1|y|yes|true)$/i.test((v ?? '').trim());
}

export function parseManifest(text: string): ManifestEntry[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '' && !l.startsWith('#'));
  if (lines.length === 0) return [];
  const first = lines[0].split('\t');
  const hasHeader = first[0].trim().toLowerCase() === 'name';
  const header = hasHeader ? first.map((h) => h.trim().toLowerCase()) : [...MANIFEST_COLUMNS];
  const rows = hasHeader ? lines.slice(1) : lines;
  return rows.map((line) => {
    const cells = line.split('\t');
    const columns: Record<string, string> = {};
    if (!hasHeader && cells.length === 2) {
      columns.name = cells[0];
      columns.notes = cells[1];
    } else {
      header.forEach((h, i) => {
        columns[h] = cells[i] ?? '';
      });
      if (cells.length > header.length && header[header.length - 1] === 'notes') {
        columns.notes = cells.slice(header.length - 1).join('\t');
      }
    }
    return {
      name: (columns.name ?? '').trim(),
      container: (columns.container ?? '').trim(),
      category: (columns.category ?? '').trim(),
      expect: (columns.expect ?? '').trim(),
      committed: parseBool(columns.committed),
      notes: columns.notes ?? '',
      columns,
    };
  });
}

export function loadManifest(path: string = MANIFEST_PATH): ManifestEntry[] {
  if (!existsSync(path)) return [];
  return parseManifest(readFileSync(path, 'utf8'));
}

export function fixturePath(name: string): string | null {
  for (const dir of [FILES_DIR, LARGE_DIR]) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

export function refPath(name: string): string {
  return join(REF_DIR, `${name}.ref.json`);
}

export function loadRef(name: string): FixtureRef | null {
  const p = refPath(name);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8')) as FixtureRef;
}

export function refVideoStreams(ref: FixtureRef): RefVideoStream[] {
  return ref.videos ?? [];
}

export function refOptionalNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === 'N/A' || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}
