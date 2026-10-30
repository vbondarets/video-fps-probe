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
  discardedPackets?: number | null;
  ptsPresented?: number[] | null;
}

export interface RefDolbyVision {
  versionMajor: number;
  versionMinor: number;
  profile: number;
  level: number;
  rpu: boolean;
  el: boolean;
  bl: boolean;
  compatibilityId: number;
  mdCompression: number;
}

export interface RefSideData {
  type: string;
  keys: string[];
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
  sampleAspectRatio: Ratio | null;
  displayAspectRatio: Ratio | null;
  colorRange: string | null;
  colorPrimaries: string | null;
  colorTransfer: string | null;
  colorSpace: string | null;
  pixFmt: string | null;
  bitDepth: number | null;
  profile: string | null;
  sideData: RefSideData[];
  dolbyVision: RefDolbyVision | null;
  rotation: number | null;
  unmappedSideData: string[];
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
    discardedPackets: numOrNull(r.discardedPackets),
    ptsPresented: Array.isArray(r.ptsPresented) && r.ptsPresented.every((x) => typeof x === 'number') ? (r.ptsPresented as number[]) : null,
  };
}

export function parseColonRatio(v: unknown): Ratio | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d+):(\d+)$/.exec(v.trim());
  if (!m) return null;
  const r = { num: Number(m[1]), den: Number(m[2]) };
  return r.num > 0 && r.den > 0 ? r : null;
}

const UNSET_COLOR = new Set(['unknown', 'unspecified', 'reserved', 'n/a']);

export function normalizedColor(v: unknown): string | null {
  const t = strOrNull(v);
  return t === null || UNSET_COLOR.has(t.toLowerCase()) ? null : t;
}

export function bitDepthOfPixFmt(pixFmt: string | null): number | null {
  if (!pixFmt) return null;
  if (/^(?:rgb|bgr)a?(?:48|64)(?:le|be)$/.test(pixFmt)) return 16;
  const deep = /(?:p|p0|gray|ya)(\d{1,2})(?:le|be)$/.exec(pixFmt);
  if (deep) return Number(deep[1]);
  return /(?:le|be)$/.test(pixFmt) ? null : 8;
}

export const DOVI_SIDE_DATA = 'DOVI configuration record';
export const DISPLAY_MATRIX_SIDE_DATA = 'Display Matrix';
export const MD_COMPRESSION: Readonly<Record<string, number>> = { none: 0, limited: 1, reserved: 2, extended: 3 };

const DOVI_KEYS: Readonly<Record<string, keyof RefDolbyVision>> = {
  dv_version_major: 'versionMajor',
  dv_version_minor: 'versionMinor',
  dv_profile: 'profile',
  dv_level: 'level',
  rpu_present_flag: 'rpu',
  el_present_flag: 'el',
  bl_present_flag: 'bl',
  dv_bl_signal_compatibility_id: 'compatibilityId',
  dv_md_compression: 'mdCompression',
};

const SIDE_DATA_KEYS: Readonly<Record<string, readonly string[]>> = {
  [DOVI_SIDE_DATA]: ['side_data_type', ...Object.keys(DOVI_KEYS)],
  [DISPLAY_MATRIX_SIDE_DATA]: ['side_data_type', 'displaymatrix', 'rotation'],
};

function dolbyVisionOf(entry: Json, unmapped: string[]): RefDolbyVision {
  const out: Record<string, number | boolean> = {};
  for (const [key, field] of Object.entries(DOVI_KEYS)) {
    const raw = entry[key];
    if (key === 'dv_md_compression') {
      const n = typeof raw === 'string' ? MD_COMPRESSION[raw] : numOrNull(raw);
      if (n === undefined || n === null) unmapped.push(`${DOVI_SIDE_DATA}.${key}=${String(raw)}`);
      out[field] = n ?? -1;
    } else if (field === 'rpu' || field === 'el' || field === 'bl') {
      out[field] = numOrNull(raw) === 1;
    } else {
      const n = numOrNull(raw);
      if (n === null) unmapped.push(`${DOVI_SIDE_DATA}.${key}=${String(raw)}`);
      out[field] = n ?? -1;
    }
  }
  return out as unknown as RefDolbyVision;
}

function sideDataOf(stream: Json): Pick<RefStream, 'sideData' | 'dolbyVision' | 'rotation' | 'unmappedSideData'> {
  const sideData: RefSideData[] = [];
  const unmapped: string[] = [];
  let dolbyVision: RefDolbyVision | null = null;
  let rotation: number | null = null;
  for (const e of arr(stream.side_data_list)) {
    const entry = rec(e);
    if (!entry) continue;
    const type = strOrNull(entry.side_data_type) ?? 'unknown';
    const keys = Object.keys(entry);
    sideData.push({ type, keys });
    const known = SIDE_DATA_KEYS[type];
    if (!known) {
      unmapped.push(`side data type "${type}"`);
      continue;
    }
    for (const k of keys) if (!known.includes(k)) unmapped.push(`${type}.${k}`);
    if (type === DOVI_SIDE_DATA) dolbyVision = dolbyVisionOf(entry, unmapped);
    if (type === DISPLAY_MATRIX_SIDE_DATA) rotation = numOrNull(entry.rotation);
  }
  return { sideData, dolbyVision, rotation, unmappedSideData: unmapped };
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
        sampleAspectRatio: parseColonRatio(s.sample_aspect_ratio),
        displayAspectRatio: parseColonRatio(s.display_aspect_ratio),
        colorRange: normalizedColor(s.color_range),
        colorPrimaries: normalizedColor(s.color_primaries),
        colorTransfer: normalizedColor(s.color_transfer),
        colorSpace: normalizedColor(s.color_space),
        pixFmt: strOrNull(s.pix_fmt),
        bitDepth: bitDepthOfPixFmt(strOrNull(s.pix_fmt)),
        profile: normalizedColor(s.profile),
        ...sideDataOf(s),
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
