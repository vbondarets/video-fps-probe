import { openAsBlob } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { analyzeHeader, warningCodesOf, type HeaderResult } from '../../src/header/index.ts';
import { FILES_DIR } from '../helpers/fixtures.ts';
import { box, bytes, ftyp, fullBox, mdatHeader, mfra, moof, moov, moovOfSize, mvex, recording, sidx, u32, virtualSource, zeros, type Segment, type VirtualSource } from '../helpers/iso-builder.ts';

const KIB = 1024;
const MIB = 1024 * 1024;
const VIDEO = { id: 1, samples: [[90, 512]] as Array<[number, number]> };

const fixture = async (name: string, options = {}): Promise<HeaderResult> => analyzeHeader(await openAsBlob(join(FILES_DIR, name)), { name, ...options });

function reads(r: HeaderResult): [number, number] {
  return [r.io.reads, r.io.bytesRequested];
}

describe('read plan of the committed fixtures', () => {
  test('a faststart moov inside the head window takes one read', async () => {
    const r = await fixture('av_h264_aac_faststart.mp4');
    expect(r.error).toBeNull();
    expect(r.layout?.kind).toBe('faststart');
    expect(r.io.reads).toBe(1);
  });

  test('a faststart moov that ends past the head window takes a second read for the rest and the next box header', async () => {
    const r = await fixture('faststart_large_moov.mp4');
    expect(r.layout).toMatchObject({ kind: 'faststart', moovOffset: 32, moovSize: 72831 });
    expect(reads(r)).toEqual([2, 32 + 72831 + 32]);
  });

  test('a moov at the end inside the tail window takes two reads', async () => {
    const r = await fixture('cfr_h264_30.mp4');
    expect(r.layout?.kind).toBe('moov-at-end');
    expect(r.io.reads).toBe(2);
    expect(r.videoTracks[0]).toMatchObject({ frames: 90, durationSec: 3 });
  });

  test('a fragmented file with a covering sidx and an mfra takes the head and the mfra tail', async () => {
    const r = await fixture('fmp4_global_sidx.mp4');
    expect(r.error).toBeNull();
    expect(r.videoTracks[0].provenance.durationSec).toBe('header');
    expect(r.io.reads).toBe(2);
  });

  test("fragmentedDuration 'header' never reads past the first fragment", async () => {
    const r = await fixture('rec_chromium_h264.mp4', { fragmentedDuration: 'header' });
    expect(r).toMatchObject({ errorCode: 'no-duration', error: 'incomplete header: fragmented file without a sidx, mfra or mehd duration' });
    expect(r.io.reads).toBe(1);
    expect(r.videoTracks).toHaveLength(1);
    expect(r.primaryTrackId).toBe(r.videoTracks[0].trackId);
  });

  test('a Matroska file is not read past the head window', async () => {
    const webm = await fixture('cfr_vp9_30.webm');
    expect(webm).toMatchObject({ container: 'webm', errorCode: 'unsupported-container', error: 'container not read by the header entry: webm', videoTracks: [] });
    expect(webm.io.reads).toBe(1);
    const mkv = await fixture('h264.mkv');
    expect(mkv).toMatchObject({ container: 'matroska', errorCode: 'unsupported-container', error: 'container not read by the header entry: matroska' });
  });

  test('an empty file takes no read', async () => {
    const r = await analyzeHeader(new Blob([]), { name: 'empty.mp4' });
    expect(r).toMatchObject({ error: 'not a recognised container: empty file', errorCode: 'empty-file', scan: 'header', layout: null });
    expect(reads(r)).toEqual([0, 0]);
  });

  test('a file that is not a container reads only the head window', async () => {
    const r = await fixture('corrupt_png_named.mp4');
    expect(r).toMatchObject({ errorCode: 'unrecognised', container: 'unknown' });
    expect(r.io.reads).toBe(1);
  });
});

describe('read plan of virtual sources', () => {
  test('a faststart moov inside 64 KiB takes one read of 64 KiB', async () => {
    const src = virtualSource([ftyp(), moov([VIDEO]), mdatHeader(MIB), { zeros: MIB }]);
    const r = await analyzeHeader(src);
    expect(r.error).toBeNull();
    expect(reads(r)).toEqual([1, 64 * KIB]);
  });

  test('a 100 KiB faststart moov in a 1 GiB file takes two reads', async () => {
    const m = moovOfSize(100 * KIB, { id: 1 });
    const head = bytes(ftyp(), m);
    const src = virtualSource([head, mdatHeader(1024 * MIB - head.length - 8), { zeros: 1024 * MIB - head.length - 8 }]);
    expect(src.size).toBe(1024 * MIB);
    const r = await analyzeHeader(src);
    expect(r.error).toBeNull();
    expect(r.layout).toMatchObject({ kind: 'faststart', moovSize: m.length });
    expect(reads(r)).toEqual([2, head.length + 32]);
  });

  test('a faststart moov over 64 KiB before a truncated mdat gets the truncated-mdat warning in the same two reads', async () => {
    const head = bytes(ftyp(), moovOfSize(102_411, { id: 1 }));
    const r = await analyzeHeader(virtualSource([head, mdatHeader(8 * MIB), { zeros: 2 * MIB }]));
    expect(r.error).toBeNull();
    expect(r.warnings).toEqual([`'mdat' at ${head.length} is truncated`]);
    expect(warningCodesOf(r)).toEqual(['truncated-mdat']);
    expect(reads(r)).toEqual([2, head.length + 32]);
  });

  test('a moov at the end inside the tail window takes two reads', async () => {
    const m = moov([VIDEO]);
    const src = virtualSource([ftyp(), mdatHeader(10 * MIB), { zeros: 10 * MIB }, m]);
    const r = await analyzeHeader(src);
    expect(r.error).toBeNull();
    expect(r.layout?.kind).toBe('moov-at-end');
    expect(reads(r)).toEqual([2, 64 * KIB + m.length]);
  });

  test('the 2.6 MB moov at the end of a 13 MB file takes three reads and stops with byte-limit after two under 2 MiB', async () => {
    const m = moovOfSize(2_614_543, { id: 1 });
    const mdat = 13 * 1000 * 1000 - m.length - 32 - 8;
    const src = virtualSource([ftyp(), mdatHeader(mdat), { zeros: mdat }, m]);
    const full = await analyzeHeader(src);
    expect(full.error).toBeNull();
    expect(full.io.reads).toBe(3);
    expect(full.io.bytesRequested).toBe(64 * KIB + m.length);
    const tight = await analyzeHeader(src, { limits: { maxBytes: 2 * MIB } });
    expect(tight.errorCode).toBe('byte-limit');
    expect(tight.error).toMatch(/^limit reached: maxBytes 2097152 \(\d+ more bytes needed at offset \d+\)$/);
    expect(tight.io.reads).toBe(2);
    expect(tight.io.bytesRequested).toBe(64 * KIB + 256 * KIB);
    expect(tight.layout).toMatchObject({ kind: 'moov-at-end', moovSize: m.length });
    expect(tight.videoTracks).toEqual([]);
  });

  test('1800 fragments without an index take at most two reads and end in no-duration', async () => {
    const { source } = recording({ fragments: 1800, mdatBytes: 100, index: false });
    const r = await analyzeHeader(source);
    expect(r.errorCode).toBe('no-duration');
    expect(r.io.reads).toBeLessThanOrEqual(2);
    expect(r.videoTracks).toHaveLength(1);
    expect(r.layout).toMatchObject({ kind: 'fragmented', emptyMoov: true });
  });

  test('a recording whose last moof is inside the tail window takes two reads, otherwise three', async () => {
    const near = recording({ fragments: 4, mdatBytes: 40 * KIB });
    const r1 = await analyzeHeader(near.source);
    expect(r1.error).toBeNull();
    expect(r1.io.reads).toBe(2);
    expect(r1.videoTracks[0].durationSec).toBe(near.videoTicks / 15360);
    const far = recording({ fragments: 4, mdatBytes: MIB });
    const r2 = await analyzeHeader(far.source);
    expect(r2.error).toBeNull();
    expect(r2.io.reads).toBe(3);
    expect(r2.videoTracks[0]).toMatchObject({ durationSec: far.videoTicks / 15360, provenance: { durationSec: 'header' } });
    expect(r2.formatDurationSec).toBe(far.videoTicks / 15360);
  });

  test('one read left is enough for the tail when the last moof is inside it', async () => {
    const near = await analyzeHeader(recording({ fragments: 4, mdatBytes: 40 * KIB }).source, { limits: { maxReads: 2 } });
    expect(near).toMatchObject({ error: null, errorCode: null });
    expect(near.io.reads).toBe(2);
    const far = await analyzeHeader(recording({ fragments: 4, mdatBytes: MIB }).source, { limits: { maxReads: 2 } });
    expect(far).toMatchObject({ errorCode: 'read-limit', error: 'limit reached: maxReads 2' });
    expect(far.io.reads).toBe(2);
  });

  test("fragmentedDuration 'header' completes a first moof that the head window cuts only for a covering sidx", async () => {
    const head = bytes(ftyp('iso5'), moov([{ id: 1, timescale: 15360 }], [mvex({ trex: [{ id: 1, duration: 512 }] })]));
    const m = moof(1, [{ id: 1, baseDts: 0, count: 300, duration: 512, cts: 1024 }], 3000);
    const options = { fragmentedDuration: 'header', readAhead: { head: KIB } } as const;
    const plain = await analyzeHeader(virtualSource([head, m, mdatHeader(3000), { zeros: 3000 }]), options);
    expect(plain.errorCode).toBe('no-duration');
    expect(plain.io.reads).toBe(1);
    const covered = await analyzeHeader(virtualSource([head, sidx(1, 15360, 1024, [[m.length + 8 + 3000, 300 * 512]]), m, mdatHeader(3000), { zeros: 3000 }]), options);
    expect(covered).toMatchObject({ error: null, formatDurationSec: 10.066667 });
    expect(covered.videoTracks[0].durationSec).toBe((300 * 512 + 1024) / 15360);
    expect(covered.io.reads).toBe(2);
  });

  test('a sound track that ends later sets the format duration', async () => {
    const rec = recording({ fragments: 3, mdatBytes: 2 * MIB, audio: true, audioLonger: 25 });
    const r = await analyzeHeader(rec.source);
    expect(r.error).toBeNull();
    expect(r.videoTracks[0].durationSec).toBe(rec.videoTicks / 15360);
    expect(r.formatDurationSec).toBeCloseTo(rec.audioTicks! / 48000, 6);
    expect(r.formatDurationSec!).toBeGreaterThan(r.videoTracks[0].durationSec!);
  });

  test('mehd gives an estimated duration only when it is valid', async () => {
    for (const [mehd, expected] of [
      [3000, 3],
      [0, null],
      [0xffffffff, null],
      [0xffffffffffffffffn, null],
    ] as const) {
      const { source } = recording({ fragments: 3, mdatBytes: 100, index: false, mehd });
      const r = await analyzeHeader(source);
      if (expected === null) expect(r.errorCode, String(mehd)).toBe('no-duration');
      else {
        expect(r.error).toBeNull();
        expect(r.videoTracks[0]).toMatchObject({ durationSec: expected, provenance: { durationSec: 'estimated' } });
        expect(r.formatDurationSec).toBe(expected);
      }
    }
  });

  test('a covering sidx after the moov resolves the duration from the head', async () => {
    const rec = recording({ fragments: 3, mdatBytes: 100, index: false, sidx: true });
    const r = await analyzeHeader(rec.source);
    expect(r.error).toBeNull();
    expect(r.layout?.sidx).toBe(true);
    expect(r.videoTracks[0]).toMatchObject({ durationSec: rec.videoTicks / 15360, provenance: { durationSec: 'header' } });
    expect(r.io.reads).toBe(1);
  });

  test('an 8 MiB free box and several mdats before the moov cost one peek each outside the windows', async () => {
    const m = moov([VIDEO]);
    const free = 8 * MIB;
    const src = virtualSource([ftyp(), mdatHeader(4 * MIB), { zeros: 4 * MIB }, box('free'), mdatHeader(2 * MIB), { zeros: 2 * MIB }, bytes(mdatHeader(free - 8)), { zeros: free - 8 }, m]);
    const r = await analyzeHeader(src);
    expect(r.error).toBeNull();
    expect(r.layout?.kind).toBe('moov-at-end');
    expect(r.io.reads).toBe(4);
  });

  test('2000 top-level free boxes stop with structure-limit under the default limit', async () => {
    const segments: Segment[] = [ftyp()];
    for (let i = 0; i < 2000; i++) segments.push(box('free', zeros(8)));
    segments.push(moov([VIDEO]));
    const r = await analyzeHeader(virtualSource(segments));
    expect(r).toMatchObject({ errorCode: 'structure-limit', error: 'limit reached: maxTopLevelBoxes 1024', videoTracks: [] });
    const ok = await analyzeHeader(virtualSource(segments), { limits: { maxTopLevelBoxes: 2002 } });
    expect(ok.error).toBeNull();
  });

  test('a moov of 20,000 trak boxes stops with structure-limit', async () => {
    const trak = box('trak', zeros(0));
    const many = box('moov', ...Array.from({ length: 20_000 }, () => trak));
    const r = await analyzeHeader(virtualSource([ftyp(), many, mdatHeader(16), zeros(16)]));
    expect(r).toMatchObject({ errorCode: 'structure-limit', error: 'limit reached: maxTracks 64', videoTracks: [], primaryTrackId: null });
    expect(r.layout).toMatchObject({ moovSize: many.length });
  });

  test('a moov that runs past the end of the file is parsed strictly as in full mode', async () => {
    const m = moov([VIDEO]);
    const cut = m.subarray(0, m.length - 40);
    const r = await analyzeHeader(virtualSource([ftyp(), cut]));
    expect(r).toMatchObject({ errorCode: 'truncated', error: 'incomplete file: moov is truncated' });
  });

  test('a sidx that does not reach the end of the file is not a duration', async () => {
    const short = sidx(1, 15360, 0, [[10, 512]]);
    const fragment = (i: number): Segment[] => [moof(i + 1, [{ id: 1, baseDts: i * 30 * 512, count: 30, duration: 512 }], 300), mdatHeader(300), zeros(300)];
    const src = virtualSource([ftyp('iso5'), moov([{ id: 1 }], [mvex({ trex: [{ id: 1, duration: 512 }] })]), short, ...fragment(0), ...fragment(1)]);
    for (const fragmentedDuration of ['index', 'header'] as const) expect((await analyzeHeader(src, { fragmentedDuration })).errorCode, fragmentedDuration).toBe('no-duration');
  });

  test('a first moof whose mdat ends the file is the whole file, so it resolves in the first read without an index', async () => {
    const short = sidx(1, 15360, 0, [[10, 512]]);
    const head = bytes(ftyp('iso5'), moov([{ id: 1 }], [mvex({ trex: [{ id: 1, duration: 512 }] })]));
    const fragment = [moof(1, [{ id: 1, baseDts: 0, count: 30, duration: 512 }], 300), mdatHeader(300), zeros(300)];
    for (const segments of [[head, short, ...fragment], [head, ...fragment], [head, ...fragment, mfra([])]]) {
      for (const fragmentedDuration of ['index', 'header'] as const) {
        const label = `${segments.length} ${fragmentedDuration}`;
        const r = await analyzeHeader(virtualSource(segments), { fragmentedDuration });
        expect(r, label).toMatchObject({ error: null, formatDurationSec: 1, warnings: [] });
        expect(r.videoTracks[0], label).toMatchObject({ durationSec: 1, provenance: { durationSec: 'header' } });
        expect(r.io.reads, label).toBe(1);
      }
    }
    const tail = virtualSource([head, ...fragment, box('free', zeros(8))]);
    expect((await analyzeHeader(tail, { fragmentedDuration: 'header' })).errorCode).toBe('no-duration');
  });

  test('a single moof indexed by the mfra resolves every track from that moof', async () => {
    const rec = recording({ fragments: 1, mdatBytes: 200 * KIB, audio: true, audioLonger: 5 });
    const r = await analyzeHeader(rec.source);
    expect(r.error).toBeNull();
    expect(r.io.reads).toBe(2);
    expect(r.videoTracks[0]).toMatchObject({ durationSec: rec.videoTicks / 15360, isStill: false, provenance: { durationSec: 'header' } });
    expect(r.formatDurationSec).toBeCloseTo(rec.audioTicks! / 48000, 6);
    expect((await analyzeHeader(rec.source, { fragmentedDuration: 'header' })).errorCode).toBe('no-duration');
  });

  test('an mvex file whose moov holds every sample reads as a file without fragments', async () => {
    const tracks = [{ id: 1, timescale: 15360, samples: [[150, 512]] as Array<[number, number]> }];
    const head = bytes(ftyp('iso5'), moov(tracks, [mvex({ trex: [{ id: 1, duration: 512 }] })]));
    for (const index of [mfra([]), mfra([{ id: 1, offsets: [] }])]) {
      const src = virtualSource([head, mdatHeader(MIB), { zeros: MIB }, index]);
      for (const fragmentedDuration of ['index', 'header'] as const) {
        const r = await analyzeHeader(src, { fragmentedDuration });
        expect(r.error, fragmentedDuration).toBeNull();
        expect(r.layout, fragmentedDuration).toMatchObject({ kind: 'fragmented', emptyMoov: false });
        expect(r.videoTracks[0], fragmentedDuration).toMatchObject({ frames: 150, durationSec: 5, provenance: { durationSec: 'header' } });
        expect(r.formatDurationSec, fragmentedDuration).toBe(5);
        expect(r.io.reads, fragmentedDuration).toBe(2);
      }
    }
  });

  test('a limit hit between the moov and the first moof keeps the tracks', async () => {
    const free = Array.from({ length: 40 }, () => box('free'));
    const withMehd = recording({ fragments: 3, mdatBytes: 1000, mehd: 6000, free });
    const estimated = await analyzeHeader(withMehd.source, { limits: { maxTopLevelBoxes: 32 } });
    expect(estimated).toMatchObject({ error: null, errorCode: null, formatDurationSec: 6, primaryTrackId: 1 });
    expect(estimated.videoTracks[0]).toMatchObject({ durationSec: 6, provenance: { durationSec: 'estimated' } });
    expect(estimated.warnings).toContain('fragment index not read: limit reached: maxTopLevelBoxes 32');
    const bare = await analyzeHeader(recording({ fragments: 3, mdatBytes: 1000, free }).source, { limits: { maxTopLevelBoxes: 32 } });
    expect(bare).toMatchObject({ errorCode: 'structure-limit', error: 'limit reached: maxTopLevelBoxes 32', primaryTrackId: 1, formatDurationSec: null });
    expect(bare.videoTracks).toHaveLength(1);
    const gap = await analyzeHeader(recording({ fragments: 3, mdatBytes: 1000, free: [box('free', zeros(70 * KIB))] }).source, { limits: { maxReads: 1 } });
    expect(gap).toMatchObject({ errorCode: 'read-limit', error: 'limit reached: maxReads 1', primaryTrackId: 1 });
    expect(gap.videoTracks).toHaveLength(1);
    const plain = virtualSource([ftyp(), moov([VIDEO]), ...free, mdatHeader(MIB), { zeros: MIB }]);
    const counted = await analyzeHeader(plain, { limits: { maxTopLevelBoxes: 32 } });
    expect(counted).toMatchObject({ error: null, errorCode: null, primaryTrackId: 1, formatDurationSec: 3 });
    expect(counted.videoTracks[0]).toMatchObject({ frames: 90, durationSec: 3 });
    expect(counted.warnings).toEqual(['too many top-level boxes']);
    expect(warningCodesOf(counted)).toEqual(['structure-limit']);
    expect(counted.io.reads).toBe(1);
  });

  test('a hostile mfro size above 16 MiB is not read', async () => {
    const head = bytes(ftyp('iso5'), moov([{ id: 1 }], [mvex({ trex: [{ id: 1, duration: 512 }] })]), moof(1, [{ id: 1, baseDts: 0, count: 30, duration: 512 }], 300));
    const src = virtualSource([head, mdatHeader(40 * MIB), { zeros: 40 * MIB }, fullBox('mfro', 0, 0, u32(30 * MIB))]);
    const r = await analyzeHeader(src, { limits: { maxBytes: Number.POSITIVE_INFINITY } });
    expect(r.errorCode).toBe('no-duration');
    expect(src.calls.every(([s, e]) => e - s <= 64 * KIB)).toBe(true);
  });

  test('a warning that repeats is reported once with its count', async () => {
    const head = bytes(ftyp('iso5'), moov([{ id: 1 }], [mvex({ trex: [{ id: 1, duration: 512 }] })]));
    const many = moof(1, Array.from({ length: 1000 }, () => ({ id: 77, baseDts: 0, count: 1, duration: 512 })), 0);
    const r = await analyzeHeader(virtualSource([head, many, mdatHeader(16), zeros(16)]));
    expect(r.warnings.filter((w) => w.startsWith('fragment for unknown track 77'))).toEqual(['fragment for unknown track 77 (1000 times)']);
  });

  test('a moof after a moov without mvex is ignored with a coded warning', async () => {
    const head = bytes(ftyp(), moov([VIDEO]), mdatHeader(1000), zeros(1000));
    const r = await analyzeHeader(virtualSource([head, moof(1, [{ id: 1, baseDts: 90 * 512, count: 30, duration: 512 }], 300), mdatHeader(300), zeros(300)]));
    expect(r).toMatchObject({ error: null, formatDurationSec: 3, layout: { kind: 'faststart' } });
    expect(r.videoTracks[0]).toMatchObject({ frames: 90, durationSec: 3 });
    expect(r.warnings).toEqual([`fragments ignored: moof at ${head.length} after a moov without an mvex`]);
    expect(warningCodesOf(r)).toEqual(['fragments-ignored']);
    expect(r.io.reads).toBe(1);
  });

  test('a moof after an mdat that ends past the bytes read is found by one peek after a moov without mvex', async () => {
    for (const payload of [70_000, MIB]) {
      const head = bytes(ftyp(), moov([VIDEO]), mdatHeader(payload));
      const at = head.length + payload;
      const open = (): VirtualSource => virtualSource([head, { zeros: payload }, moof(1, [{ id: 1, baseDts: 90 * 512, count: 30, duration: 512 }], 300), mdatHeader(300), zeros(300)]);
      const r = await analyzeHeader(open());
      expect(r, String(payload)).toMatchObject({ error: null, formatDurationSec: 3, warnings: [`fragments ignored: moof at ${at} after a moov without an mvex`] });
      expect(r.io.reads, String(payload)).toBe(2);
      const limited = await analyzeHeader(open(), { limits: { maxReads: 1 } });
      expect(limited, String(payload)).toMatchObject({ errorCode: 'read-limit', formatDurationSec: 3 });
      expect(limited.videoTracks[0], String(payload)).toMatchObject({ frames: 90, durationSec: 3 });
    }
  });

  test('an mdat that ends before the end of the file costs one peek past it, and only one', async () => {
    const head = bytes(ftyp(), moov([VIDEO]), mdatHeader(MIB));
    const r = await analyzeHeader(virtualSource([head, { zeros: MIB }, box('free', zeros(8)), mdatHeader(MIB), { zeros: MIB }, box('free', zeros(8))]));
    expect(r).toMatchObject({ error: null, warnings: [] });
    expect(r.io.reads).toBe(2);
  });

  test('a truncated mdat and trailing data after a moov without mvex are noted from the bytes read', async () => {
    const m = moov([VIDEO]);
    const head = bytes(ftyp(), m, box('free', zeros(100)));
    const cut = virtualSource([head, mdatHeader(10 * MIB), { zeros: MIB }]);
    const r = await analyzeHeader(cut);
    expect(r.error).toBeNull();
    expect(r.io.reads).toBe(1);
    expect(r.warnings).toContain(`'mdat' at ${head.length} is truncated`);
    const junk = await analyzeHeader(virtualSource([ftyp(), mdatHeader(MIB), { zeros: MIB }, m, bytes([0, 0, 0, 2, 0x6a, 0x75, 0x6e, 0x6b])]));
    expect(junk.error).toBeNull();
    expect(junk.warnings.some((w) => w.startsWith('ignored trailing data at '))).toBe(true);
  });
});
