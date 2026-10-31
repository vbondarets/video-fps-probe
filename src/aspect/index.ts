import {
  boxPayload,
  elementUint,
  elements,
  firstBox,
  i32,
  ID_DISPLAY_HEIGHT,
  ID_DISPLAY_UNIT,
  ID_DISPLAY_WIDTH,
  ID_PIXEL_HEIGHT,
  ID_PIXEL_WIDTH,
  ID_STEREO_MODE,
  isoConfig,
  matroskaConfig,
  u32,
  type IsoConfig,
  type MatroskaConfig,
  type Span,
} from '../color/config.ts';
import { avcConfigSps, hevcConfigSps, type SpsInfo } from '../color/sps.ts';
import type { FileResult, Rational, VideoTrackResult } from '../core/types.ts';
import { avD2q, avReduce, INT_MAX, type Ratio } from './rational.ts';

export type { CodecConfig, Rational } from '../core/types.ts';

export interface AspectInfo {
  sampleAspectRatio: Rational | null;
  displayAspectRatio: Rational | null;
  displayWidth: number | null;
  displayHeight: number | null;
}

export type AspectTrack = Pick<VideoTrackResult, 'codecName' | 'width' | 'height' | 'rotation' | 'codecConfig'>;

const DAR_MAX = 1048576n;
const MATRIX_SCALE_LIMIT = 1 << 24;
const MATRIX_SCALE_TOLERANCE = 0.01;
const DISPLAY_UNIT_UNKNOWN = 4;
const WIDTH_TIMES_TWO = new Set([1, 8, 9, 11]);
const HEIGHT_TIMES_TWO = new Set([2, 3, 6, 7]);
const ID_PIXEL_CROP_BOTTOM = 0x54aa;
const ID_PIXEL_CROP_TOP = 0x54bb;
const ID_PIXEL_CROP_LEFT = 0x54cc;
const ID_PIXEL_CROP_RIGHT = 0x54dd;
const ID_PROJECTION = 0x7670;
const ID_PROJECTION_TYPE = 0x7671;
const ID_PROJECTION_PRIVATE = 0x7672;
const ID_PROJECTION_POSE_YAW = 0x7673;
const ID_PROJECTION_POSE_PITCH = 0x7674;
const ID_PROJECTION_POSE_ROLL = 0x7675;

function rational([num, den]: Ratio): Rational {
  return { num: Number(num), den: Number(den), value: Number(num) / Number(den) };
}

const valid = (r: Ratio | null): r is Ratio => r !== null && r[0] > 0n && r[1] > 0n;

function vuiRatio(sps: SpsInfo | null): Ratio | null {
  const sar = sps?.vui?.sar;
  return sar ? avReduce(BigInt(sar[0]), BigInt(sar[1]), INT_MAX) : null;
}

function configSps(codec: string, b: Uint8Array, s: Span | null): SpsInfo | null {
  return !s ? null : codec === 'h264' ? avcConfigSps(b, s) : codec === 'hevc' ? hevcConfigSps(b, s) : null;
}

function matrixOf(box: Uint8Array | null, offset: (version: number) => number): bigint[] | null {
  const p = boxPayload(box);
  if (!box || !p) return null;
  const at = p.start + offset(box[p.start]);
  if (at + 36 > p.end) return null;
  return Array.from({ length: 9 }, (_, i) => BigInt(i32(box, at + i * 4)));
}

function tkhdSizeAt(iso: IsoConfig): number {
  const tkhd = boxPayload(iso.tkhd);
  const at = iso.tkhd && tkhd ? tkhd.start + (iso.tkhd[tkhd.start] === 1 ? 88 : 76) : -1;
  return tkhd && at + 8 <= tkhd.end ? at : -1;
}

function matrixRatio(iso: IsoConfig, sizeAt: number): Ratio | null {
  if (!iso.tkhd || sizeAt < 0 || !u32(iso.tkhd, sizeAt) || !u32(iso.tkhd, sizeAt + 4)) return null;
  const track = matrixOf(iso.tkhd, (v) => (v === 1 ? 52 : 40));
  if (!track) return null;
  const movie = matrixOf(iso.mvhd, (v) => (v === 1 ? 48 : 36)) ?? Array<bigint>(9).fill(0n);
  const shift = [16n, 16n, 30n];
  const m: number[] = [];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let sum = 0n;
      for (let e = 0; e < 3; e++) sum += (track[i * 3 + e] * movie[e * 3 + j]) >> shift[e];
      m.push(Number(BigInt.asIntN(32, sum)));
    }
  }
  const identity = m[0] === 65536 && m[4] === 65536 && m[8] === 1 << 30 && !m[1] && !m[2] && !m[3] && !m[5] && !m[6] && !m[7];
  if (identity) return null;
  const x = Math.hypot(m[0], m[3]);
  const y = Math.hypot(m[1], m[4]);
  if (!(x > 1 && y > 1 && x < MATRIX_SCALE_LIMIT && y < MATRIX_SCALE_LIMIT && Math.abs(x / y - 1) > MATRIX_SCALE_TOLERANCE)) return null;
  return avD2q(x / y, INT_MAX);
}

function isoRatio(track: AspectTrack, iso: IsoConfig): Ratio | null {
  const sizeAt = tkhdSizeAt(iso);
  let pasp: Ratio | null = null;
  for (const entry of iso.entries) {
    for (const c of entry.children) {
      if (c.type === 'pasp' && c.end - c.start >= 8 && i32(iso.bytes, c.start + 4)) pasp = [BigInt(i32(iso.bytes, c.start)), BigInt(i32(iso.bytes, c.start + 4))];
    }
  }
  let sar = pasp?.[0] ? avReduce(pasp[0], pasp[1], INT_MAX) : matrixRatio(iso, sizeAt);
  if (!sar?.[0] && iso.tkhd && sizeAt >= 0) {
    const w = BigInt(i32(iso.tkhd, sizeAt) >> 16);
    const h = BigInt(i32(iso.tkhd, sizeAt + 4) >> 16);
    const sw = BigInt(track.width);
    const sh = BigInt(track.height);
    if (w && h && sw && sh && (sw !== w || sh !== h)) sar = avReduce(sh * w, sw * h, INT_MAX);
  }
  if (valid(sar)) return sar;
  const entry = iso.entries[0];
  return vuiRatio(configSps(track.codecName, iso.bytes, firstBox(entry, track.codecName === 'h264' ? 'avcC' : 'hvcC')));
}

function matroskaCodec(mkv: MatroskaConfig): string {
  return mkv.codecId === 'V_MPEG4/ISO/AVC' ? 'h264' : mkv.codecId === 'V_MPEGH/ISO/HEVC' ? 'hevc' : '';
}

function matroskaRatio(mkv: MatroskaConfig): Ratio | null {
  const b = mkv.bytes;
  const video = (id: number): number | null => elementUint(b, mkv.video.get(id));
  const unit = video(ID_DISPLAY_UNIT) ?? 0;
  let sar: Ratio | null = null;
  const croppedWidth = (video(ID_PIXEL_WIDTH) ?? 0) - (video(ID_PIXEL_CROP_LEFT) ?? 0) - (video(ID_PIXEL_CROP_RIGHT) ?? 0);
  const croppedHeight = (video(ID_PIXEL_HEIGHT) ?? 0) - (video(ID_PIXEL_CROP_TOP) ?? 0) - (video(ID_PIXEL_CROP_BOTTOM) ?? 0);
  if (unit < DISPLAY_UNIT_UNKNOWN && croppedWidth > 0 && croppedHeight > 0) {
    const dw = video(ID_DISPLAY_WIDTH) ?? (unit === 0 ? croppedWidth : null);
    const dh = video(ID_DISPLAY_HEIGHT) ?? (unit === 0 ? croppedHeight : null);
    const stereo = video(ID_STEREO_MODE) ?? 0;
    if (dw && dh) {
      const wmul = WIDTH_TIMES_TWO.has(stereo) ? 2n : 1n;
      const hmul = HEIGHT_TIMES_TWO.has(stereo) ? 2n : 1n;
      sar = avReduce(BigInt(croppedHeight) * BigInt(dw) * wmul, BigInt(croppedWidth) * BigInt(dh) * hmul, INT_MAX);
    }
  }
  return valid(sar) ? sar : vuiRatio(configSps(matroskaCodec(mkv), b, mkv.codecPrivate));
}

function elementFloat(b: Uint8Array, span: Span | undefined): number {
  const n = span ? span.end - span.start : 0;
  if (!span || (n !== 4 && n !== 8)) return 0;
  const dv = new DataView(b.buffer, b.byteOffset + span.start, n);
  return n === 4 ? dv.getFloat32(0) : dv.getFloat64(0);
}

function projectionRotation(mkv: MatroskaConfig): number {
  const span = mkv.video.get(ID_PROJECTION);
  if (!span) return 0;
  const b = mkv.bytes;
  const projection = new Map<number, Span>();
  for (const e of elements(b, span.start, span.end)) projection.set(e.id, e);
  const extra = projection.get(ID_PROJECTION_PRIVATE);
  if ((elementUint(b, projection.get(ID_PROJECTION_TYPE)) ?? 0) !== 0 || (extra && extra.end > extra.start && b[extra.start] !== 0)) return 0;
  const yaw = elementFloat(b, projection.get(ID_PROJECTION_POSE_YAW));
  const roll = elementFloat(b, projection.get(ID_PROJECTION_POSE_ROLL));
  if (elementFloat(b, projection.get(ID_PROJECTION_POSE_PITCH)) !== 0 || (yaw !== 0 && Math.abs(yaw) !== 180) || Number.isNaN(roll)) return 0;
  const flip = yaw !== 0 ? -1 : 1;
  const radians = (roll * flip * Math.PI) / 180;
  const a = (flip * Math.trunc(Math.cos(radians) * 65536)) / 65536;
  const c = Math.trunc(-Math.sin(radians) * 65536) / 65536;
  const s0 = Math.hypot(a, (flip * Math.trunc(Math.sin(radians) * 65536)) / 65536);
  const s1 = Math.hypot(c, Math.trunc(Math.cos(radians) * 65536) / 65536);
  return s0 && s1 ? Math.trunc(-((Math.atan2(c / s1, a / s0) * 180) / Math.PI)) || 0 : 0;
}

export function aspectOf(track: AspectTrack): AspectInfo | undefined {
  const config = track.codecConfig;
  const iso = config && isoConfig(config);
  const mkv = config && !iso ? matroskaConfig(config) : null;
  if (!iso && !mkv) return undefined;
  const sar = iso ? isoRatio(track, iso) : matroskaRatio(mkv as MatroskaConfig);
  const usable = valid(sar) ? sar : null;
  const { width, height } = track;
  if (width <= 0 || height <= 0) return { sampleAspectRatio: usable && rational(usable), displayAspectRatio: null, displayWidth: null, displayHeight: null };
  const [num, den] = usable ?? [1n, 1n];
  const storedWidth = Number((2n * BigInt(width) * num + den) / (2n * den));
  const rotation = track.rotation || (mkv ? projectionRotation(mkv) : 0);
  const swap = Math.abs(rotation) % 180 === 90;
  return {
    sampleAspectRatio: usable && rational(usable),
    displayAspectRatio: usable && rational(avReduce(BigInt(width) * num, BigInt(height) * den, DAR_MAX)),
    displayWidth: swap ? height : storedWidth,
    displayHeight: swap ? storedWidth : height,
  };
}

export function withAspect<R extends Pick<FileResult, 'videoTracks'>>(result: R, options: { keepCodecConfig?: boolean } = {}): R {
  return {
    ...result,
    videoTracks: result.videoTracks.map((t) => {
      if (!t.codecConfig) return t;
      const out = { ...t, ...aspectOf(t) };
      if (!options.keepCodecConfig) delete out.codecConfig;
      return out;
    }),
  };
}
