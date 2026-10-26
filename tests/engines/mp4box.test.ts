import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { analyzeWithMp4box } from '../../src/engines/mp4box.ts';
import type { Mp4boxResult } from '../../src/engines/types.ts';
import { fixturePath, loadManifest, loadRef } from '../helpers/fixtures.ts';
import { withFixture } from '../helpers/open-blob.ts';
import { compareToRef, formatTally, tally, type FieldDiff } from './deviation.ts';
import { expectContract, expectExact } from './engine-contract.ts';

const AGREES_WITH_FFPROBE = [
  'avgFps',
  'frames',
  'presentedFrames',
  'minFps',
  'maxFps',
  'isVfr',
  'duplicates',
  'width',
  'height',
  'codec',
];

const CURATED: ReadonlyArray<readonly [label: string, name: string]> = [
  ['moov at the end, CFR', 'cfr_h264_30.mp4'],
  ['faststart MOV', 'mov_nobf_faststart.mov'],
  ['B-frames with an edit list (MOV)', 'mov_bf_elst.mov'],
  ['B-frames without an edit list (MP4)', 'mp4_bf_noelst.mp4'],
  ['VFR concat', 'vfr_concat_10_30_60.mp4'],
  ['VFR concat with B-frames', 'vfr_concat_bframes.mp4'],
  ['fragmented, empty moov', 'fmp4_keyframe_empty_moov.mp4'],
  ['fragmented CMAF', 'fmp4_cmaf.mp4'],
  ['64-bit mdat header', 'box64_mdat64_free.mp4'],
  ['HEVC', 'hevc_hvc1.mp4'],
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

async function run(name: string): Promise<{ result: Mp4boxResult; size: number }> {
  const path = fixturePath(name);
  if (!path) throw new Error(`fixture ${name} is missing`);
  return withFixture(path, async (blob, size) => ({ result: await analyzeWithMp4box(blob, name), size }));
}

describe('analyzeWithMp4box on representative fixtures', () => {
  it.each(CURATED)('%s (%s)', async (_label, name) => {
    const { result, size } = await run(name);
    expectContract(result, 'mp4box', name, size);
    expect(result.error).toBeNull();
    expect(result.videoTracks.length).toBeGreaterThan(0);
    const ref = loadRef(name);
    expect(ref).not.toBeNull();
    expectExact(compareToRef(result, ref!), AGREES_WITH_FFPROBE);
    expect(result.mp4box?.version).toBe('2.4.1');
    expect(result.mp4box?.tracks.length).toBe(result.videoTracks.length);
    expect(result.videoTracks[0].warnings.some((w) => w.startsWith('mp4box native:'))).toBe(true);
  });

  it('reads little: one or two windows for a small non-fragmented file', async () => {
    const { result } = await run('cfr_h264_30.mp4');
    expect(result.io.reads).toBeLessThanOrEqual(2);
    expect(result.io.bytesRead).toBeLessThan(140_000);
  });

  it('feeds each fragment as moof plus a few bytes, never the whole file', async () => {
    const { result, size } = await run('fmp4_cmaf.mp4');
    expect(result.mp4box!.moofsFed).toBeGreaterThan(0);
    expect(result.mp4box!.fedBytes).toBeLessThan(size);
  });

  it('reports the hybrid fragmented file over all fragments', async () => {
    const { result } = await run('fmp4_hybrid_no_empty_moov.mp4');
    expect(result.error).toBeNull();
    expect(result.videoTracks[0].frames).toBe(120);
  });

  it('ends a fragmented track at the tfdt timeline, not at the sum of the trun durations', async () => {
    for (const name of ['rec_chromium_h264.mp4', 'rec_chromium_vp9.mp4', 'rec_chromium_h264_sliced.mp4']) {
      const { result } = await run(name);
      const ref = loadRef(name)!;
      expect(result.videoTracks[0].durationSec).toBeCloseTo(Number(ref.videos![0].duration), 6);
      expect(result.formatDurationSec).toBeCloseTo(Number(ref.format!.duration), 6);
    }
  });

  it('reports the native view next to the exact one', async () => {
    const { result } = await run('mov_bf_elst.mov');
    const native = result.mp4box!.tracks[0];
    expect(native.sampleCount).toBe(90);
    expect(native.sttsLastDelta).not.toBeNull();
    expect(native.fpsFromSampleDurations).not.toBeNull();
  });

  it('rejects Matroska and WebM as unsupported', async () => {
    for (const name of ['cfr_vp9_30.webm', 'h264.mkv']) {
      const { result, size } = await run(name);
      expectContract(result, 'mp4box', name, size);
      expect(result.error).toBe('unsupported by mp4box');
      expect(result.container).toBe('matroska');
      expect(result.videoTracks).toEqual([]);
      expect(result.io.reads).toBe(1);
    }
  });

  it('detects containers by content, not by file name', async () => {
    const { result } = await run('sniff_mp4_named_webm.webm');
    expect(result.error).toBeNull();
    expect(result.videoTracks.length).toBe(1);
  });

  it('reports audio only files without a video track', async () => {
    const { result, size } = await run('audio_only.m4a');
    expectContract(result, 'mp4box', 'audio_only.m4a', size);
    expect(result.error).toBeNull();
    expect(result.videoTracks).toEqual([]);
    expect(result.audioTrackCount).toBe(1);
    expect(result.warnings).toContain('no video track');
  });

  it.each(GARBAGE)('returns an error result instead of throwing for %s', async (_label, name) => {
    const { result, size } = await run(name);
    expectContract(result, 'mp4box', name, size);
    expect(result.error).not.toBeNull();
    expect(result.videoTracks).toEqual([]);
  });

  it('replaces NUL and other control characters in the warnings mp4box logs', async () => {
    const bytes = readFileSync(fixturePath('cfr_h264_30.mp4')!);
    const moovAt = bytes.indexOf('moov', 0, 'latin1') - 4;
    const moovSize = bytes.readUInt32BE(moovAt);
    expect(moovAt + moovSize).toBe(bytes.length);
    const child = Buffer.from([0, 0, 0, 16, 0x00, 0x01, 0x61, 0x62, ...new Array<number>(8).fill(0)]);
    const file = Buffer.concat([bytes, child]);
    file.writeUInt32BE(moovSize + child.length, moovAt);
    const result = await analyzeWithMp4box(new Blob([file]), 'control.mp4');
    expect(result.error).toBeNull();
    const warnings = [...result.warnings, ...result.videoTracks.flatMap((t) => t.warnings)];
    expect(warnings.join('\n')).toMatch(/Invalid box type: '\?\?ab'/);
    expect(warnings.filter((w) => /[^\x20-\x7e\xa0-\uffff]/.test(w))).toEqual([]);
  });

  it('reports progress phases', async () => {
    const phases: string[] = [];
    await withFixture(fixturePath('cfr_h264_30.mp4')!, (blob) =>
      analyzeWithMp4box(blob, 'x.mp4', { onProgress: (p) => phases.push(p.phase) }),
    );
    expect(phases).toEqual(['read', 'analyze']);
  });

  it('rethrows an aborted signal', async () => {
    const path = fixturePath('cfr_h264_30.mp4')!;
    const controller = new AbortController();
    controller.abort();
    await withFixture(path, async (blob) => {
      await expect(analyzeWithMp4box(blob, 'x.mp4', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    });
  });
});

describe('analyzeWithMp4box over the committed corpus', () => {
  const entries = loadManifest().filter((e) => e.committed);
  const rows: Array<{ name: string; diffs: FieldDiff[] }> = [];
  const errors = new Map<string, number>();

  it.each(entries.map((e) => e.name))('%s: no crash, engine contract holds', async (name) => {
    const { result, size } = await run(name);
    expectContract(result, 'mp4box', name, size);
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
    console.info(`${formatTally('mp4box vs ffprobe 8.1.1', t)}\n${lines}\n${errorLines}`);
  });
});
