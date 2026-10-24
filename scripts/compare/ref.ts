export interface Ratio {
  num: number;
  den: number;
}

export interface RefFps extends Ratio {
  value: number;
}

export interface RefInstFps {
  count: number;
  distinctDeltas: number;
  minFps: RefFps | null;
  maxFps: RefFps | null;
}

export interface RefPackets {
  packets: number;
  presentedPackets: number;
  duplicateTimestamps: number;
  reorderDepth: number;
  instFpsAll: RefInstFps | null;
  instFpsExcludingTail: RefInstFps | null;
  isVfr: boolean | null;
  avgFromPts: RefFps | null;
  avgFromPtsFrames: number | null;
  avgFromPtsSpanTicks: number | null;
  lastDurationTicks: number | null;
  medianDeltaTicks: number | null;
  firstPts?: number | null;
  lastPts?: number | null;
  lastPacketEndSec?: number | null;
  ptsPresented?: number[] | null;
}

export interface RefStream {
  index: number;
  codecName: string;
  width: number;
  height: number;
  timeBase: Ratio;
  avgFrameRate: string;
  rFrameRate: string;
  nbFrames: number | null;
  nbReadFrames: number | null;
  nbReadPackets: number | null;
  durationTs: number | null;
  startPts: number | null;
  enabled: boolean;
  durationTagSec: number | null;
  packets: RefPackets | null;
}

export interface RefFile {
  name: string;
  ok: boolean;
  ffprobeVersion: string | null;
  formatName: string | null;
  formatDurationRaw: string | null;
  formatDurationSec: number | null;
  videoStreams: RefStream[];
  attachedPicCount: number;
  audioCount: number;
  otherStreamTypes: string[];
  stderr: string[];
}

type Json = Record<string, unknown>;

function rec(v: unknown): Json | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : null;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function numOrNull(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (t === '' || t === 'N/A') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function strOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' || t === 'N/A' ? null : t;
}

export function parseRatio(s: string | null | undefined): Ratio | null {
  if (!s) return null;
  const m = /^(-?\d+)\/(-?\d+)$/.exec(s.trim());
  return m ? { num: Number(m[1]), den: Number(m[2]) } : null;
}

function fpsOrNull(v: unknown): RefFps | null {
  const r = rec(v);
  if (!r) return null;
  const num = numOrNull(r.num);
  const den = numOrNull(r.den);
  const value = numOrNull(r.value);
  if (num === null || den === null || value === null) return null;
  return { num, den, value };
}

function instFpsOrNull(v: unknown): RefInstFps | null {
  const r = rec(v);
  if (!r) return null;
  return {
    count: numOrNull(r.count) ?? 0,
    distinctDeltas: numOrNull(r.distinctDeltas) ?? 0,
    minFps: fpsOrNull(r.minFps),
    maxFps: fpsOrNull(r.maxFps),
  };
}

function packetsOf(v: unknown): RefPackets | null {
  const r = rec(v);
  if (!r) return null;
  const vfr = rec(r.vfr);
  return {
    packets: numOrNull(r.packets) ?? 0,
    presentedPackets: numOrNull(r.presentedPackets) ?? 0,
    duplicateTimestamps: numOrNull(r.duplicateTimestamps) ?? 0,
    reorderDepth: numOrNull(r.reorderDepth) ?? 0,
    instFpsAll: instFpsOrNull(r.instFpsAll),
    instFpsExcludingTail: instFpsOrNull(r.instFpsExcludingTail),
    isVfr: vfr && typeof vfr.isVfr === 'boolean' ? vfr.isVfr : null,
    avgFromPts: fpsOrNull(rec(r.avgFromPts)?.fps),
    avgFromPtsFrames: numOrNull(rec(r.avgFromPts)?.frames),
    avgFromPtsSpanTicks: numOrNull(rec(r.avgFromPts)?.spanTicks),
    lastDurationTicks: numOrNull(rec(r.avgFromPts)?.lastDurationTicks),
    medianDeltaTicks: vfr ? numOrNull(vfr.medianDeltaTicks) : null,
    firstPts: numOrNull(rec(r.avgFromPts)?.firstPts),
    lastPts: numOrNull(rec(r.avgFromPts)?.lastPts),
    lastPacketEndSec: numOrNull(rec(r.lastPacketEnd)?.seconds),
    ptsPresented: Array.isArray(r.ptsPresented) && r.ptsPresented.every((x) => typeof x === 'number') ? (r.ptsPresented as number[]) : null,
  };
}

function tagDurationSec(tags: Json | null): number | null {
  const raw = tags ? strOrNull(tags.DURATION ?? tags.duration) : null;
  if (!raw) return null;
  const m = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(raw);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

function isDefaultDisposition(stream: Json): boolean {
  const d = rec(stream.disposition);
  return !!d && numOrNull(d.default) === 1;
}

function isAttachedPic(stream: Json): boolean {
  const d = rec(stream.disposition);
  return !!d && numOrNull(d.attached_pic) === 1;
}

export function parseRef(name: string, json: unknown): RefFile {
  const root = rec(json) ?? {};
  const probe = rec(root.probe);
  const format = rec(probe?.format);
  const derived = new Map<number, Json>();
  for (const e of arr(root.videoStreams)) {
    const r = rec(e);
    const idx = r ? numOrNull(r.index) : null;
    if (r && idx !== null) derived.set(idx, r);
  }
  const videoStreams: RefStream[] = [];
  let attachedPicCount = 0;
  let audioCount = 0;
  const otherStreamTypes: string[] = [];
  for (const e of arr(probe?.streams)) {
    const s = rec(e);
    if (!s) continue;
    const type = strOrNull(s.codec_type) ?? 'unknown';
    if (type === 'audio') audioCount++;
    else if (type === 'video') {
      if (isAttachedPic(s)) {
        attachedPicCount++;
        continue;
      }
      const index = numOrNull(s.index) ?? videoStreams.length;
      const tb = parseRatio(strOrNull(s.time_base)) ?? { num: 1, den: 1 };
      videoStreams.push({
        index,
        codecName: strOrNull(s.codec_name) ?? '',
        width: numOrNull(s.width) ?? 0,
        height: numOrNull(s.height) ?? 0,
        timeBase: tb,
        avgFrameRate: strOrNull(s.avg_frame_rate) ?? '0/0',
        rFrameRate: strOrNull(s.r_frame_rate) ?? '0/0',
        nbFrames: numOrNull(s.nb_frames),
        nbReadFrames: numOrNull(s.nb_read_frames),
        nbReadPackets: numOrNull(s.nb_read_packets),
        durationTs: numOrNull(s.duration_ts),
        startPts: numOrNull(s.start_pts),
        enabled: isDefaultDisposition(s),
        durationTagSec: tagDurationSec(rec(s.tags)),
        packets: packetsOf(derived.get(index)),
      });
    } else otherStreamTypes.push(type);
  }
  const stderr = arr(root.stderr).filter((x): x is string => typeof x === 'string');
  return {
    name,
    ok: root.ok === true,
    ffprobeVersion: strOrNull(root.ffprobeVersion),
    formatName: strOrNull(format?.format_name),
    formatDurationRaw: strOrNull(format?.duration),
    formatDurationSec: numOrNull(format?.duration),
    videoStreams,
    attachedPicCount,
    audioCount,
    otherStreamTypes,
    stderr,
  };
}

export function ticksToSec(ticks: number, tb: Ratio): number {
  return (ticks * tb.num) / tb.den;
}
