import { afterAll, describe, expect, it } from 'vitest';
import { analyzeWithMediabunny, NATIVE_STATS_MAX_PACKETS } from '../../src/engines/mediabunny.ts';
import type { MediabunnyResult } from '../../src/engines/types.ts';
import { fixturePath, loadManifest, loadRef } from '../helpers/fixtures.ts';
import { withFixture } from '../helpers/open-blob.ts';
import { compareToRef, formatTally, tally, type FieldDiff } from './deviation.ts';
import { expectContract, expectExact } from './engine-contract.ts';

const TIMELINE_FIELDS = ['frames', 'presentedFrames', 'minFps', 'maxFps', 'isVfr', 'duplicates', 'width', 'height', 'codec'];

const CURATED_MP4: ReadonlyArray<readonly [label: string, name: string, fields: readonly string[]]> = [
  ['moov at the end, CFR', 'cfr_h264_30.mp4', [...TIMELINE_FIELDS, 'avgFps']],
  ['faststart MOV', 'mov_nobf_faststart.mov', [...TIMELINE_FIELDS, 'avgFps']],
  ['B-frames with an edit list (MOV)', 'mov_bf_elst.mov', [...TIMELINE_FIELDS, 'avgFps']],
  ['VFR concat', 'vfr_concat_10_30_60.mp4', [...TIMELINE_FIELDS, 'avgFps']],
  ['VFR concat with B-frames', 'vfr_concat_bframes.mp4', TIMELINE_FIELDS],
  ['fragmented, empty moov', 'fmp4_keyframe_empty_moov.mp4', [...TIMELINE_FIELDS, 'avgFps']],
  ['fragmented CMAF', 'fmp4_cmaf.mp4', [...TIMELINE_FIELDS, 'avgFps']],
  ['HEVC', 'hevc_hvc1.mp4', [...TIMELINE_FIELDS, 'avgFps']],
];

const CURATED_WEBM: ReadonlyArray<readonly [label: string, name: string]> = [
  ['VP9 CFR 29.97', 'cfr_vp9_29.97.webm'],
  ['VP9 CFR 60', 'cfr_vp9_60.webm'],
  ['VP9 VFR concat', 'vfr_concat_10_30_60.webm'],
  ['VP9 screen recording', 'vfr_screenrec_ts1000.webm'],
  ['Matroska H.264', 'h264.mkv'],
];

const GARBAGE: ReadonlyArray<readonly [label: string, name: string]> = [
  ['0-byte file', 'corrupt_empty_0byte.mp4'],
  ['random bytes', 'corrupt_garbage_random.mp4'],
  ['text file', 'corrupt_text_named.mp4'],
  ['PNG named .mp4', 'corrupt_png_named.mp4'],
  ['truncated before moov', 'corrupt_trunc_no_moov.mp4'],
  ['moov cut in half', 'corrupt_trunc_moov_partial.mp4'],
  ['lying stts entry count', 'corrupt_stts_count_huge.mp4'],
];

async function run(name: string): Promise<{ result: MediabunnyResult; size: number }> {
  const path = fixturePath(name);
  if (!path) throw new Error(`fixture ${name} is missing`);
  return withFixture(path, async (blob, size) => ({ result: await analyzeWithMediabunny(blob, name), size }));
}

describe('analyzeWithMediabunny on representative fixtures', () => {
  it.each(CURATED_MP4)('%s (%s)', async (_label, name, fields) => {
    const { result, size } = await run(name);
    expectContract(result, 'mediabunny', name, size);
    expect(result.error).toBeNull();
    expect(result.videoTracks.length).toBeGreaterThan(0);
    expectExact(compareToRef(result, loadRef(name)!), fields);
    expect(result.mediabunny?.version).toBe('1.62.0');
    expect(result.mediabunny?.tracks[0].packetCount).toBe(result.videoTracks[0].frames);
    expect(result.videoTracks[0].warnings.some((w) => w.startsWith('mediabunny native:'))).toBe(true);
  });

  it.each(CURATED_WEBM)('%s (%s)', async (_label, name) => {
    const { result, size } = await run(name);
    expectContract(result, 'mediabunny', name, size);
    expect(result.error).toBeNull();
    expect(['webm', 'matroska']).toContain(result.container);
    expectExact(compareToRef(result, loadRef(name)!), TIMELINE_FIELDS);
    expect(result.videoTracks[0].timestampsQuantized || result.videoTracks[0].isVfr).toBe(true);
    expect(result.warnings.some((w) => w.includes('whole clusters'))).toBe(true);
  });

  it('reports the native average next to the one computed from timestamps', async () => {
    const { result } = await run('cfr_vp9_29.97.webm');
    const native = result.mediabunny!.tracks[0];
    expect(native.averagePacketRate).not.toBeNull();
    expect(native.fpsFromTimestamps).not.toBeNull();
    expect(Math.abs(result.videoTracks[0].avgFps!.value / native.averagePacketRate! - 1)).toBeLessThan(1e-8);
    expect(native.nativeCallSkipped).toBe(false);
  });

  it('keeps native stats out of the io numbers', async () => {
    const { result } = await run('cfr_h264_30.mp4');
    expect(result.io.reads).toBeLessThanOrEqual(2);
    expect(result.mediabunny!.nativeStatsMs).toBeGreaterThanOrEqual(0);
  });

  it('detects containers by content, not by file name', async () => {
    const { result } = await run('sniff_mp4_named_webm.webm');
    expect(result.error).toBeNull();
    expect(result.container).toBe('mp4');
    expect(result.videoTracks.length).toBe(1);
  });

  it('reports audio only files without a video track', async () => {
    const { result, size } = await run('audio_only.m4a');
    expectContract(result, 'mediabunny', 'audio_only.m4a', size);
    expect(result.error).toBeNull();
    expect(result.videoTracks).toEqual([]);
    expect(result.audioTrackCount).toBe(1);
    expect(result.warnings).toContain('no video track');
  });

  it('warns when a truncated file exposes no tracks at all', async () => {
    const { result } = await run('corrupt_trunc_no_moov.mp4');
    expect(result.error).toBeNull();
    expect(result.warnings.some((w) => w.includes('no tracks'))).toBe(true);
  });

  it.each(GARBAGE)('returns a result instead of throwing for %s', async (_label, name) => {
    const { result, size } = await run(name);
    expectContract(result, 'mediabunny', name, size);
  });

  it('rejects unrecognised content with the shared error prefix', async () => {
    const { result } = await run('corrupt_garbage_random.mp4');
    expect(result.error).toMatch(/^not a recognised container/);
    const empty = await run('corrupt_empty_0byte.mp4');
    expect(empty.result.error).toBe('not a recognised container: empty file');
    expect(empty.result.io.reads).toBe(0);
  });

  it('reports one progress step per video track', async () => {
    const steps: string[] = [];
    await withFixture(fixturePath('multi_video_2tracks.mp4')!, (blob) =>
      analyzeWithMediabunny(blob, 'x.mp4', { onProgress: (p) => steps.push(`${p.phase}:${p.done}/${p.total}`) }),
    );
    expect(steps).toEqual(['packets:0/2', 'packets:1/2']);
  });

  it('rethrows an aborted signal', async () => {
    const path = fixturePath('cfr_h264_30.mp4')!;
    const controller = new AbortController();
    controller.abort();
    await withFixture(path, async (blob) => {
      await expect(analyzeWithMediabunny(blob, 'x.mp4', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    });
  });

  it('iterates 648,000 packets of the long CFR file without the iterator stall', async () => {
    const path = fixturePath('long_cfr_3h_60fps.mp4');
    if (!path) return;
    const { result } = await withFixture(path, async (blob, size) => ({ result: await analyzeWithMediabunny(blob, 'long.mp4'), size }));
    expect(result.error).toBeNull();
    expect(result.videoTracks[0].frames).toBe(648_000);
    expect(result.videoTracks[0].frames!).toBeGreaterThan(NATIVE_STATS_MAX_PACKETS);
    expect(result.mediabunny!.tracks[0].nativeCallSkipped).toBe(true);
    expect(result.io.ms).toBeLessThan(20_000);
  });
});

describe('analyzeWithMediabunny over the committed corpus', () => {
  const entries = loadManifest().filter((e) => e.committed);
  const rows: Array<{ name: string; diffs: FieldDiff[] }> = [];
  const errors = new Map<string, number>();

  it.each(entries.map((e) => e.name))('%s: no crash, engine contract holds', async (name) => {
    const { result, size } = await run(name);
    expectContract(result, 'mediabunny', name, size);
    const ref = loadRef(name);
    rows.push({ name, diffs: ref ? compareToRef(result, ref) : [] });
    if (result.error !== null) errors.set(result.error, (errors.get(result.error) ?? 0) + 1);
  });

  afterAll(() => {
    const t = tally(rows);
    const lines = rows
      .flatMap((r) => r.diffs.filter((d) => d.verdict === 'mismatch').map((d) => `  ${r.name} v${d.track}.${d.field}: ${String(d.actual)} vs ffprobe ${String(d.expected)}`))
      .join('\n');
    const errorLines = [...errors].map(([message, count]) => `  ${count} x error: ${message}`).join('\n');
    console.info(`${formatTally('mediabunny vs ffprobe 8.1.1', t)}\n${lines}\n${errorLines}`);
  });
});
