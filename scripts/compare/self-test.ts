import { avReduce } from '../../src/core/rational.ts';
import { emptyAnalysis, emptyTrack } from '../../src/core/result.ts';
import type { FileResult, Rational, VideoTrackResult } from '../../src/core/types.ts';
import { parseDeviations } from './deviations.ts';
import { ARMS } from './engines.ts';
import { classifyEvaluation } from './outcomes.ts';
import { loadManifest, loadRef } from '../../tests/helpers/fixtures.ts';
import { parseRatio, parseRef, ticksToSec, type RefFile, type RefFps, type RefInstFps, type RefStream } from './ref.ts';
import { evaluate, expectedPrimary, pairTracks, type EvaluateInput, type Evaluation } from './rules.ts';
import type { CheckResult, FileLayout, FixtureInfo } from './types.ts';

function rat(num: number, den: number): Rational {
  const r = avReduce(num, den);
  return { num: r.num, den: r.den, value: r.num / r.den };
}

function fps(num: number, den: number): RefFps {
  return { num, den, value: num / den };
}

function inst(count: number, distinct: number, min: RefFps, max: RefFps): RefInstFps {
  return { count, distinctDeltas: distinct, minFps: min, maxFps: max };
}

function refStream(over: Partial<RefStream> = {}): RefStream {
  return {
    index: 0,
    codecName: 'h264',
    width: 160,
    height: 90,
    timeBase: { num: 1, den: 30000 },
    avgFrameRate: '30000/1001',
    rFrameRate: '30000/1001',
    nbFrames: 90,
    nbReadFrames: 90,
    nbReadPackets: 90,
    durationTs: 90090,
    startPts: 0,
    enabled: true,
    durationTagSec: null,
    packets: {
      packets: 90,
      presentedPackets: 90,
      duplicateTimestamps: 0,
      reorderDepth: 0,
      instFpsAll: inst(89, 1, fps(30000, 1001), fps(30000, 1001)),
      instFpsExcludingTail: inst(89, 1, fps(30000, 1001), fps(30000, 1001)),
      isVfr: false,
      avgFromPts: fps(30000, 1001),
      avgFromPtsFrames: 90,
      avgFromPtsSpanTicks: 90090,
      lastDurationTicks: 1001,
      medianDeltaTicks: 1001,
    },
    ...over,
  };
}

function refFile(streams: RefStream[], over: Partial<RefFile> = {}): RefFile {
  return {
    name: 'synthetic',
    ok: true,
    ffprobeVersion: 'ffprobe version 8.1.1',
    formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
    formatDurationRaw: '3.003000',
    formatDurationSec: 3.003,
    videoStreams: streams,
    attachedPicCount: 0,
    audioCount: 0,
    otherStreamTypes: [],
    stderr: [],
    ...over,
  };
}

function appTrack(over: Partial<VideoTrackResult> = {}): VideoTrackResult {
  return {
    ...emptyTrack(1),
    codecName: 'h264',
    width: 160,
    height: 90,
    timescale: 30000,
    frames: 90,
    presentedFrames: 90,
    durationSec: 3.003,
    startSec: 0,
    avgFps: rat(30000, 1001),
    avgFpsFfprobe: '30000/1001',
    nominalFps: { ...rat(30000, 1001), kind: 'exact' },
    minFps: rat(30000, 1001),
    maxFps: rat(30000, 1001),
    isVfr: false,
    ...over,
  };
}

function appResult(tracks: VideoTrackResult[], over: Partial<FileResult> = {}): FileResult {
  return {
    name: 'synthetic',
    size: 1000,
    ...emptyAnalysis('mp4'),
    formatDurationSec: 3.003,
    videoTracks: tracks,
    primaryTrackId: tracks[0]?.trackId ?? null,
    io: { reads: 1, bytesRead: 1000, ms: 1 },
    engine: 'own',
    ...over,
  };
}

const MP4_INFO: FixtureInfo = { name: 'synthetic.mp4', container: 'mp4', category: 'cfr', expect: 'ok', notes: '' };
const MKV_INFO: FixtureInfo = { name: 'synthetic.webm', container: 'webm', category: 'cfr', expect: 'ok', notes: '' };

function all(e: Evaluation): CheckResult[] {
  return [...e.fileChecks, ...e.tracks.flatMap((t) => t.checks)];
}

function verdictOf(e: Evaluation, id: string): string {
  const c = all(e).find((x) => x.id === id);
  return c ? c.verdict : 'missing';
}

function ratioOf(s: string): Rational | null {
  const r = parseRatio(s);
  return r && r.den !== 0 ? { num: r.num, den: r.den, value: r.num / r.den } : null;
}

function oracleTrack(s: RefStream, trackId: number, matroska: boolean): VideoTrackResult {
  const inst = s.packets?.instFpsExcludingTail ?? null;
  const avg = ratioOf(s.avgFrameRate);
  const r = ratioOf(s.rFrameRate);
  const packets = s.nbReadPackets ?? s.packets?.packets ?? null;
  let frames = s.nbFrames ?? packets;
  if (!matroska && s.nbFrames !== null && packets !== null && s.nbFrames < packets) frames = packets;
  if (matroska) frames = packets;
  const measured = s.packets?.avgFromPts ?? null;
  return {
    ...emptyTrack(trackId),
    codecName: s.codecName,
    width: s.width,
    height: s.height,
    timescale: s.timeBase.den,
    frames,
    presentedFrames: s.nbReadFrames,
    durationSec: !matroska && s.durationTs !== null ? ticksToSec(s.durationTs, s.timeBase) : null,
    startSec: s.startPts !== null ? ticksToSec(s.startPts, s.timeBase) : null,
    avgFps: matroska ? (measured ? { ...measured } : null) : avg && measured ? { ...measured } : avg,
    avgFpsFfprobe: avg ? s.avgFrameRate : null,
    rFpsFfprobe: matroska && r ? s.rFrameRate : null,
    nominalFps: !matroska && r && inst?.distinctDeltas === 1 ? { ...r, kind: 'exact' } : null,
    minFps: inst?.minFps ? { ...inst.minFps } : null,
    maxFps: inst?.maxFps ? { ...inst.maxFps } : null,
    isVfr: s.packets?.isVfr ?? null,
    duplicateTimestamps: s.packets?.duplicateTimestamps ?? 0,
    isStill: (frames ?? 0) <= 1,
    provenance: { avgFps: 'exact', frames: 'exact', presentedFrames: 'exact', startSec: 'exact' },
  };
}

export function oracleResult(info: FixtureInfo, ref: RefFile): FileResult {
  const matroska = info.container === 'webm' || info.container === 'matroska';
  const family = matroska ? 'matroska' : 'isobmff';
  const all = ref.videoStreams.map((s, i) => oracleTrack(s, i + 1, matroska));
  const expected = expectedPrimary(family, ref.videoStreams);
  const primary = expected ? all[ref.videoStreams.indexOf(expected)].trackId : null;
  const hasTracks = info.expect === 'ok' || info.expect === 'still';
  return {
    name: info.name,
    size: 0,
    ...emptyAnalysis(info.container === 'mov' ? 'mov' : matroska ? 'webm' : 'mp4', info.expect === 'error' ? 'not a recognised container' : null),
    formatDurationSec: ref.formatDurationSec,
    scan: 'exact',
    videoTracks: hasTracks ? all : [],
    primaryTrackId: hasTracks ? primary : null,
    io: { reads: 1, bytesRead: 1, ms: 1 },
    engine: 'own',
  };
}

function oracleRoundTrip(expectEq: (label: string, actual: unknown, expected: unknown) => void): number {
  const manifest = loadManifest();
  let evaluated = 0;
  for (const m of manifest) {
    const raw = loadRef(m.name);
    if (!raw) continue;
    const ref = parseRef(m.name, raw);
    if (!ref.ok && m.expect === 'ok') continue;
    const info: FixtureInfo = { name: m.name, container: m.container, category: m.category, expect: m.expect, notes: m.notes };
    const e = evaluate({ info, ref, result: oracleResult(info, ref) });
    const bad = [...e.fileChecks, ...e.tracks.flatMap((t) => t.checks)].filter((c) => c.verdict === 'mismatch').map((c) => c.id);
    expectEq(`oracle round trip ${m.name}`, bad.join(','), '');
    evaluated++;
  }
  return evaluated;
}

export function runSelfTest(): number {
  let total = 0;
  const failures: string[] = [];
  const expectEq = (label: string, actual: unknown, expected: unknown) => {
    total++;
    if (actual !== expected) failures.push(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  };
  const run = (input: Partial<EvaluateInput> & Pick<EvaluateInput, 'info' | 'ref' | 'result'>): Evaluation => evaluate(input);

  const cfr = run({ info: MP4_INFO, ref: refFile([refStream()]), result: appResult([appTrack()]) });
  expectEq('mp4 cfr: no mismatch', all(cfr).filter((c) => c.verdict === 'mismatch').length, 0);
  expectEq('mp4 cfr: avgFps exact', verdictOf(cfr, 'avgFps'), 'exact');
  expectEq('mp4 cfr: nominalFps exact', verdictOf(cfr, 'nominalFps'), 'exact');
  expectEq('mp4 cfr: frames exact', verdictOf(cfr, 'frames'), 'exact');
  expectEq('mp4 cfr: durationSec exact', verdictOf(cfr, 'durationSec'), 'exact');
  expectEq('mp4 cfr: trackSelection exact', verdictOf(cfr, 'trackSelection'), 'exact');

  const wrongAvg = appTrack({ avgFps: rat(30, 1), avgFpsFfprobe: '30/1', frames: 91 });
  const bad = run({ info: MP4_INFO, ref: refFile([refStream()]), result: appResult([wrongAvg]) });
  expectEq('mp4 wrong avg: mismatch', verdictOf(bad, 'avgFps'), 'mismatch');
  expectEq('mp4 wrong frames: mismatch', verdictOf(bad, 'frames'), 'mismatch');
  const reason = 'synthetic reason that is concrete enough';
  const excused = run({
    info: MP4_INFO,
    ref: refFile([refStream()]),
    result: appResult([wrongAvg]),
    deviations: { avgFps: reason, durationSec: reason },
  });
  expectEq('mp4 deviation: known-deviation', verdictOf(excused, 'avgFps'), 'known-deviation');
  expectEq('mp4 deviation: other mismatch stays', verdictOf(excused, 'frames'), 'mismatch');
  expectEq('mp4 deviation: stale key reported', excused.unusedDeviationKeys.join(','), 'durationSec');

  const presented = (over: Partial<VideoTrackResult>): Evaluation =>
    run({ info: MP4_INFO, ref: refFile([refStream()]), result: appResult([appTrack({ provenance: { avgFps: 'exact' }, ...over })]) });
  expectEq('mp4 header average: measured n/a', verdictOf(cfr, 'avgFps.measured'), 'n/a');
  expectEq('mp4 presented average: measured exact', verdictOf(presented({}), 'avgFps.measured'), 'exact');
  expectEq('mp4 presented average, span 5 ticks off: within-tol', verdictOf(presented({ avgFps: rat(90 * 30000, 90095) }), 'avgFps.measured'), 'within-tol');
  expectEq('mp4 presented average, one frame more: mismatch', verdictOf(presented({ avgFps: rat(91 * 30000, 90090), presentedFrames: 91 }), 'avgFps.measured'), 'mismatch');
  expectEq('mp4 presented average, span a frame off: mismatch', verdictOf(presented({ avgFps: rat(90 * 30000, 91091) }), 'avgFps.measured'), 'mismatch');
  expectEq('mp4 presented average differs: ffprobe parity uses avgFpsFfprobe', verdictOf(presented({ avgFps: rat(25, 1) }), 'avgFps'), 'exact');

  const fragRef = refFile(
    [
      refStream({
        avgFrameRate: '60/1',
        rFrameRate: '60/1',
        nbFrames: null,
        nbReadPackets: 140,
        nbReadFrames: 140,
        packets: { ...refStream().packets!, avgFromPts: fps(4200, 149), packets: 140, presentedPackets: 140 },
      }),
    ],
    { formatDurationRaw: '3.003000' },
  );
  const fragApp = appResult([appTrack({ avgFps: rat(4200, 149), avgFpsFfprobe: '4200/149', frames: 140, presentedFrames: 140 })]);
  const sidx: FileLayout = { fragmented: true, hasSidx: true, topLevel: ['ftyp', 'moov', 'sidx', 'moof'] };
  const underRead = run({ info: MP4_INFO, ref: fragRef, result: fragApp, layout: sidx });
  const underReadCheck = all(underRead).find((c) => c.id === 'avgFps');
  expectEq('fragmented sidx: built-in known-deviation', underReadCheck?.verdict, 'known-deviation');
  expectEq('fragmented sidx: built-in source', underReadCheck?.deviationSource, 'built-in');
  const noSidx = run({ info: MP4_INFO, ref: fragRef, result: fragApp, layout: { ...sidx, hasSidx: false } });
  expectEq('fragmented without sidx: mismatch', verdictOf(noSidx, 'avgFps'), 'mismatch');
  expectEq('fragmented frames vs nb_read_packets', verdictOf(underRead, 'frames'), 'exact');

  const mkvRef = refFile(
    [
      refStream({
        nbFrames: null,
        durationTs: null,
        timeBase: { num: 1, den: 1000 },
        packets: { ...refStream().packets!, instFpsExcludingTail: inst(89, 2, fps(1000, 34), fps(1000, 33)), isVfr: false, avgFromPts: fps(30000, 1001) },
      }),
    ],
    { formatName: 'matroska,webm' },
  );
  const mkvTrack = appTrack({
    minFps: rat(1000, 34),
    maxFps: rat(1000, 33),
    avgFps: rat(30000, 1001),
    provenance: { avgFps: 'exact', frames: 'computed', presentedFrames: 'exact', startSec: 'exact' },
    rFpsFfprobe: '30000/1001',
    timestampsQuantized: true,
  });
  const mkv = run({ info: MKV_INFO, ref: mkvRef, result: appResult([mkvTrack], { container: 'webm', scan: 'exact' }) });
  expectEq('mkv: no mismatch', all(mkv).filter((c) => c.verdict === 'mismatch').length, 0);
  expectEq('mkv: declared avg exact', verdictOf(mkv, 'avgFps.declared'), 'exact');
  expectEq('mkv: measured avg exact', verdictOf(mkv, 'avgFps.measured'), 'exact');
  expectEq('mkv: frames exact vs nb_read_packets', verdictOf(mkv, 'frames'), 'exact');
  expectEq('mkv: track duration n/a', verdictOf(mkv, 'durationSec'), 'n/a');
  const headerOnly = run({
    info: MKV_INFO,
    ref: mkvRef,
    result: appResult([{ ...mkvTrack, provenance: { avgFps: 'header', frames: 'estimated' }, frames: 120 }], { container: 'webm', scan: 'header' }),
  });
  expectEq('mkv header scan: measured avg n/a', verdictOf(headerOnly, 'avgFps.measured'), 'n/a');
  expectEq('mkv header scan: estimated frames n/a', verdictOf(headerOnly, 'frames'), 'n/a');
  const noDeclared = { ...mkvTrack, avgFpsFfprobe: null, rFpsFfprobe: null };
  const lost = run({ info: MKV_INFO, ref: mkvRef, result: appResult([noDeclared], { container: 'webm', scan: 'exact' }) });
  expectEq('mkv lost DefaultDuration: mismatch', verdictOf(lost, 'avgFps.declared'), 'mismatch');
  const voided = run({
    info: { ...MKV_INFO, notes: 'DefaultDuration element overwritten by an EBML Void' },
    ref: mkvRef,
    result: appResult([noDeclared], { container: 'webm', scan: 'exact' }),
  });
  expectEq('mkv without DefaultDuration: n/a', verdictOf(voided, 'avgFps.declared'), 'n/a');

  const still = refStream({
    index: 0,
    codecName: 'mjpeg',
    width: 64,
    height: 64,
    nbFrames: 1,
    nbReadPackets: 1,
    nbReadFrames: 1,
    avgFrameRate: '25/1',
    rFrameRate: '25/1',
  });
  const real = refStream({ index: 1 });
  const stillTrack = appTrack({ trackId: 1, codecName: 'mjpeg', width: 64, height: 64, isStill: true, frames: 1, presentedFrames: 1, avgFps: null, avgFpsFfprobe: null, nominalFps: null, minFps: null, maxFps: null, isVfr: null });
  const realTrack = appTrack({ trackId: 2 });
  const refs = refFile([still, real]);
  const good = run({ info: MP4_INFO, ref: refs, result: appResult([stillTrack, realTrack], { primaryTrackId: 2 }) });
  expectEq('track selection: still ignored', verdictOf(good, 'trackSelection'), 'exact');
  const wrong = run({ info: MP4_INFO, ref: refs, result: appResult([stillTrack, realTrack], { primaryTrackId: 1 }) });
  expectEq('track selection: wrong primary', verdictOf(wrong, 'trackSelection'), 'mismatch');
  const disabledLarger = refStream({ index: 1, nbFrames: 200, enabled: false });
  expectEq('primary skips a disabled track', expectedPrimary('isobmff', [refStream(), disabledLarger])?.index, 0);
  expectEq('matroska primary ignores the default flag', expectedPrimary('matroska', [disabledLarger, refStream()])?.index, 1);
  const pairs = pairTracks([realTrack], [still, real]);
  expectEq('pairing: shape match skips the still', pairs[0].ref?.index, 1);
  expectEq('pairing: unmatched ref kept', pairs[1].app, null);

  const slightlyOff = run({ info: MP4_INFO, ref: refFile([refStream()]), result: appResult([appTrack()], { formatDurationSec: 3.0030009 }) });
  expectEq('format duration: within 1e-6', verdictOf(slightlyOff, 'formatDurationSec'), 'within-tol');
  const farOff = run({ info: MP4_INFO, ref: refFile([refStream()]), result: appResult([appTrack()], { formatDurationSec: 3.01 }) });
  expectEq('format duration: mismatch', verdictOf(farOff, 'formatDurationSec'), 'mismatch');

  const errExpected = run({
    info: { ...MP4_INFO, expect: 'error' },
    ref: refFile([], { ok: false, stderr: ['moov atom not found'] }),
    result: appResult([], { error: 'incomplete file: no moov', primaryTrackId: null }),
  });
  expectEq('expect error: exact', verdictOf(errExpected, 'error'), 'exact');
  expectEq('expect error: no value checks', all(errExpected).length, 1);
  const stub = run({ info: MP4_INFO, ref: refFile([refStream()]), result: appResult([], { error: 'not implemented yet', primaryTrackId: null }) });
  expectEq('expect ok with error: mismatch', verdictOf(stub, 'error'), 'mismatch');
  const noVideoStub = run({
    info: { ...MP4_INFO, expect: 'no-video' },
    ref: refFile([]),
    result: appResult([], { error: 'not implemented yet', primaryTrackId: null }),
  });
  expectEq('expect no-video with unrelated error: mismatch', verdictOf(noVideoStub, 'error'), 'mismatch');
  const thrown = run({
    info: { ...MP4_INFO, expect: 'error' },
    ref: refFile([], { ok: false, stderr: ['moov atom not found'] }),
    result: appResult([], { error: 'x', primaryTrackId: null }),
    threw: 'TypeError: boom',
  });
  expectEq('engine that throws is a mismatch even when an error is expected', verdictOf(thrown, 'error'), 'mismatch');
  const noVideo = run({ info: { ...MP4_INFO, expect: 'no-video' }, ref: refFile([]), result: appResult([], { primaryTrackId: null }) });
  expectEq('expect no-video: exact', verdictOf(noVideo, 'error'), 'exact');

  const outcomeOf = (arm: keyof typeof ARMS, input: Pick<EvaluateInput, 'info' | 'ref' | 'result'> & { layout?: FileLayout }, id: string): string => {
    const e = run(input);
    classifyEvaluation({ arm: ARMS[arm], info: input.info, ref: input.ref, result: input.result, layout: input.layout ?? null, family: e.family }, e);
    return all(e).find((c) => c.id === id)?.outcome ?? 'none';
  };
  const cfrRef = refFile([refStream()]);
  expectEq('outcome: an unread container', outcomeOf('mp4box-tuned', { info: MKV_INFO, ref: cfrRef, result: appResult([], { error: 'unsupported by mp4box' }) }, 'error'), 'unsupported-container');
  expectEq('outcome: a field outside the recipe', outcomeOf('mp4box-idiomatic', { info: MP4_INFO, ref: cfrRef, result: appResult([appTrack({ avgFps: null, avgFpsFfprobe: null })]) }, 'avgFps'), 'not-provided');
  expectEq('outcome: no value', outcomeOf('mediabunny-tuned', { info: MP4_INFO, ref: cfrRef, result: appResult([appTrack({ frames: null })]) }, 'frames'), 'not-provided');
  expectEq('outcome: a float within 1e-6', outcomeOf('mediabunny-idiomatic', { info: MP4_INFO, ref: cfrRef, result: appResult([appTrack({ avgFps: rat(2997003, 100000), avgFpsFfprobe: null })]) }, 'avgFps'), 'definition-differs');
  expectEq('outcome: a different rate', outcomeOf('mediabunny-idiomatic', { info: MP4_INFO, ref: cfrRef, result: appResult([appTrack({ avgFps: rat(25, 1), avgFpsFfprobe: null })]) }, 'avgFps'), 'wrong');
  const span = refStream({ avgFrameRate: '100/3', packets: { ...refStream().packets!, avgFromPts: fps(100, 3), avgFromPtsFrames: 200, firstPts: 0, lastPts: 538500, avgFromPtsSpanTicks: 540000 }, timeBase: { num: 1, den: 90000 } });
  expectEq('outcome: the mean frame interval', outcomeOf('mediabunny-idiomatic', { info: MP4_INFO, ref: refFile([span]), result: appResult([appTrack({ avgFps: rat(11940, 359), avgFpsFfprobe: null })]) }, 'avgFps'), 'definition-differs');
  const movie: FileLayout = { fragmented: false, hasSidx: false, topLevel: ['ftyp', 'moov', 'mdat'], movieDurationSec: 3.07, tracks: [] };
  expectEq('outcome: the movie header duration', outcomeOf('mp4box-idiomatic', { info: MP4_INFO, ref: cfrRef, layout: movie, result: appResult([appTrack()], { formatDurationSec: 3.07 }) }, 'formatDurationSec'), 'definition-differs');
  expectEq('outcome: another format duration', outcomeOf('mp4box-idiomatic', { info: MP4_INFO, ref: cfrRef, layout: movie, result: appResult([appTrack()], { formatDurationSec: 2.5 }) }, 'formatDurationSec'), 'wrong');
  expectEq('outcome: failing like ffprobe', outcomeOf('mediabunny-full', { info: MP4_INFO, ref: refFile([], { ok: false, stderr: ['error reading header'] }), result: appResult([], { error: 'internal error' }) }, 'error'), 'definition-differs');
  expectEq('outcome: VFR on a CFR fixture', outcomeOf('mediabunny-full', { info: MP4_INFO, ref: cfrRef, result: appResult([appTrack({ isVfr: true })]) }, 'isVfr'), 'wrong');
  const lastStart = refStream({ packets: { ...refStream().packets!, firstPts: 0, lastPts: 89089 } });
  expectEq('outcome: the last frame timestamp', outcomeOf('mediabunny-idiomatic', { info: MP4_INFO, ref: refFile([lastStart]), result: appResult([appTrack()], { formatDurationSec: 89089 / 30000 }) }, 'formatDurationSec'), 'definition-differs');
  expectEq('outcome: a frame count from the full scan', outcomeOf('mediabunny-full', { info: MP4_INFO, ref: cfrRef, result: appResult([appTrack({ frames: 91 })]) }, 'frames'), 'wrong');
  expectEq('outcome: no frame count in the default recipe', outcomeOf('mediabunny-idiomatic', { info: MP4_INFO, ref: cfrRef, result: appResult([appTrack({ frames: 91 })]) }, 'frames'), 'not-provided');
  expectEq('outcome: the own engine is classified too', outcomeOf('own', { info: MP4_INFO, ref: cfrRef, result: appResult([appTrack({ frames: 91 })]) }, 'frames'), 'wrong');

  const problems: string[] = [];
  const parsed = new Map<string, Record<string, string>>();
  parseDeviations(
    'inline.json',
    JSON.stringify({ 'a.mp4': { avgFps: reason, bogus: reason, frames: 'short' }, 'b.mp4': 'nope' }),
    parsed,
    problems,
  );
  expectEq('deviation file: valid entry kept', parsed.get('a.mp4')?.avgFps, reason);
  expectEq('deviation file: three problems', problems.length, 3);

  const roundTripped = oracleRoundTrip(expectEq);
  console.log(`self-test: oracle round trip over ${roundTripped} fixture reference(s)`);

  if (failures.length > 0) {
    for (const f of failures) console.error(`self-test FAIL ${f}`);
    console.error(`self-test: ${failures.length} of ${total} checks failed`);
    return 1;
  }
  console.log(`self-test: ${total} checks passed`);
  return 0;
}
