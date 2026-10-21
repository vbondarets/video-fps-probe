import { openAsBlob } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { analyze } from '../../src/core/index.ts';
import type { FileResult, MatroskaMode, VideoTrackResult } from '../../src/core/types.ts';
import { FILES_DIR, loadManifest } from '../helpers/fixtures.ts';

export type CompareEngine = 'mp4box' | 'mediabunny' | 'rvfc';

export interface ProbeHook {
  readonly results: FileResult[];
  readonly pending: number;
  runEngine(index: number, engine: CompareEngine): Promise<FileResult>;
}

export type ProbeWindow = Window & { __fpsProbe?: ProbeHook };

export const committedFixtures = (): string[] =>
  loadManifest()
    .filter((e) => e.committed)
    .map((e) => e.name);

export const fixtureFile = (name: string): string => join(FILES_DIR, name);

export async function nodeAnalyze(name: string, matroskaMode: MatroskaMode): Promise<FileResult> {
  const blob = await openAsBlob(fixtureFile(name));
  return analyze(blob, name, { matroskaMode });
}

export async function openApp(page: Page, mode?: MatroskaMode): Promise<void> {
  await page.goto('./');
  await page.waitForFunction(() => (window as ProbeWindow).__fpsProbe !== undefined);
  if (mode) await page.getByLabel('Matroska scan').selectOption(mode);
}

export async function waitSettled(page: Page, cards: number, timeout = 60_000): Promise<void> {
  await page.waitForFunction(
    (n) => document.querySelectorAll('article.card').length === n && (window as ProbeWindow).__fpsProbe?.pending === 0,
    cards,
    { timeout },
  );
}

export async function addFixtures(page: Page, names: string[]): Promise<void> {
  const before = await page.locator('article.card').count();
  await page.getByTestId('file-input').setInputFiles(names.map(fixtureFile));
  await waitSettled(page, before + names.length);
}

export const probeResults = (page: Page): Promise<FileResult[]> => page.evaluate(() => (window as ProbeWindow).__fpsProbe!.results);

function trackContract(t: VideoTrackResult) {
  return {
    trackId: t.trackId,
    fourccOrCodecId: t.fourccOrCodecId,
    codecName: t.codecName,
    width: t.width,
    height: t.height,
    frames: t.frames,
    presentedFrames: t.presentedFrames,
    durationSec: t.durationSec,
    avgFps: t.avgFps,
    avgFpsFfprobe: t.avgFpsFfprobe,
    rFpsFfprobe: t.rFpsFfprobe,
    minFps: t.minFps,
    maxFps: t.maxFps,
    isVfr: t.isVfr,
    rateProfile: t.rateProfile ? { segments: t.rateProfile.segments.length + t.rateProfile.moreSegments, uneven: t.rateProfile.uneven } : null,
  };
}

export function contract(r: FileResult) {
  return {
    name: r.name,
    size: r.size,
    container: r.container,
    formatDurationSec: r.formatDurationSec,
    scan: r.scan,
    hasError: r.error !== null,
    audioTrackCount: r.audioTrackCount,
    primaryTrackId: r.primaryTrackId,
    videoTracks: r.videoTracks.map(trackContract),
  };
}

export function withoutTiming(r: FileResult): Omit<FileResult, 'io'> & { io: { reads: number; bytesRead: number } } {
  return { ...r, io: { reads: r.io.reads, bytesRead: r.io.bytesRead } };
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
