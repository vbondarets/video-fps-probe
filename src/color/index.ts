import type { CodecConfig, ColorInfo, ColorSource, DolbyVisionConfig, FileResult, VideoTrackResult } from '../core/types.ts';
import { dolbyVisionString, isoConfigFacts, matroskaConfigFacts, type ConfigFacts } from './codec-string.ts';
import {
  elementUint,
  fourccAt,
  ID_BITS_PER_CHANNEL,
  ID_BLOCK_ADD_ID_EXTRA_DATA,
  ID_BLOCK_ADD_ID_TYPE,
  ID_MATRIX_COEFFICIENTS,
  ID_PRIMARIES,
  ID_RANGE,
  ID_TRANSFER_CHARACTERISTICS,
  isoConfig,
  matroskaConfig,
  u16,
  type Span,
} from './config.ts';
import { colorNames, namedCodes, UNSPECIFIED, type ColorCodes } from './names.ts';

export type { CodecConfig, ColorInfo, ColorSource, DolbyVisionConfig } from '../core/types.ts';

export type ColorTrack = Pick<VideoTrackResult, 'codecName' | 'codecConfig'>;

interface ContainerColor {
  source: ColorSource;
  codes: ColorCodes;
  fullRange: boolean | null;
}

const DOLBY_VISION_FOURCCS = new Set(['dvh1', 'dvhe', 'dvav', 'dva1', 'dav1']);
const DOLBY_VISION_BOXES = ['dvcC', 'dvvC', 'dvwC'];
const DOLBY_VISION_MAPPINGS = new Set([0x64766343, 0x64767643]);
const SPS_CODECS = new Set(['h264', 'hevc']);

function dolbyVision(b: Uint8Array, s: Span): DolbyVisionConfig | null {
  if (s.end - s.start < 4) return null;
  const p = s.start;
  const bits = u16(b, p + 2);
  const more = s.end - s.start >= 5;
  return {
    versionMajor: b[p],
    versionMinor: b[p + 1],
    profile: bits >> 9,
    level: (bits >> 3) & 63,
    rpu: (bits & 4) !== 0,
    el: (bits & 2) !== 0,
    bl: (bits & 1) !== 0,
    compatibilityId: more ? b[p + 4] >> 4 : 0,
    mdCompression: more ? (b[p + 4] >> 2) & 3 : 0,
  };
}

function colrOf(b: Uint8Array, s: Span): ContainerColor | null {
  if (s.end - s.start < 10) return null;
  const kind = fourccAt(b, s.start);
  if (kind !== 'nclx' && kind !== 'nclc') return null;
  const codes = namedCodes([u16(b, s.start + 4), u16(b, s.start + 6), u16(b, s.start + 8)]);
  return { source: 'colr', codes, fullRange: kind === 'nclx' ? (s.end - s.start >= 11 ? b[s.start + 10] >> 7 === 1 : false) : null };
}

function vpcOf(b: Uint8Array, s: Span): ContainerColor | null {
  if (s.end - s.start < 12 || b[s.start] !== 1) return null;
  const p = s.start + 4;
  return { source: 'vpcC', codes: namedCodes([b[p + 3], b[p + 4], b[p + 5]]), fullRange: (b[p + 2] & 1) === 1 };
}

function matroskaColour(b: Uint8Array, colour: ReadonlyMap<number, Span>): ContainerColor | null {
  if (!colour.size) return null;
  const code = (id: number, reserved: readonly number[]): number => {
    const v = elementUint(b, colour.get(id)) ?? UNSPECIFIED;
    return reserved.includes(v) ? UNSPECIFIED : v;
  };
  const range = elementUint(b, colour.get(ID_RANGE));
  return { source: 'Colour', codes: [code(ID_PRIMARIES, [0, 3]), code(ID_TRANSFER_CHARACTERISTICS, [0, 3]), code(ID_MATRIX_COEFFICIENTS, [3])], fullRange: range === 1 ? false : range === 2 ? true : null };
}

function hdrOf(transfer: string | null): ColorInfo['hdr'] {
  return transfer === 'smpte2084' ? 'pq' : transfer === 'arib-std-b67' ? 'hlg' : null;
}

function resolve(codecName: string, container: ContainerColor | null, facts: ConfigFacts | null, dv: DolbyVisionConfig | null, bitDepth: number | null): ColorInfo {
  const vui = SPS_CODECS.has(codecName) ? (facts?.sps?.vui ?? null) : null;
  const specified = container !== null && container.codes.some((c) => c !== UNSPECIFIED);
  const codes = specified ? container.codes : vui?.colour ? namedCodes(vui.colour) : null;
  const source: ColorSource | null = specified ? container.source : vui?.colour ? 'sps' : null;
  let fullRange = container?.fullRange ?? vui?.fullRange ?? null;
  if (fullRange === null && codecName === 'hevc' && facts?.sps) fullRange = false;
  const [primaries, transfer, space] = colorNames(codes);
  return {
    range: fullRange === null ? null : fullRange ? 'pc' : 'tv',
    primaries,
    transfer,
    space,
    source: codes?.some((c) => c !== UNSPECIFIED) ? source : null,
    bitDepth: facts?.bitDepth ?? bitDepth,
    profile: facts?.profile ?? null,
    codecString: facts?.codecString ?? null,
    hdr: hdrOf(transfer),
    dolbyVision: dv,
  };
}

function isoColor(codecName: string, config: CodecConfig): ColorInfo | null | undefined {
  const iso = isoConfig(config);
  if (!iso) return undefined;
  const first = iso.entries[0];
  if (!first) return null;
  const b = iso.bytes;
  let container: ContainerColor | null = null;
  let fullRange: boolean | null = null;
  let dv: DolbyVisionConfig | null = null;
  for (const entry of iso.entries) {
    for (const c of entry.children) {
      const found = c.type === 'colr' ? colrOf(b, c) : c.type === 'vpcC' ? vpcOf(b, c) : null;
      if (found) {
        container = found;
        fullRange = found.fullRange ?? fullRange;
      }
      if (DOLBY_VISION_BOXES.includes(c.type)) dv = dolbyVision(b, c) ?? dv;
    }
  }
  const facts = isoConfigFacts(codecName, b, first);
  if (dv && facts && DOLBY_VISION_FOURCCS.has(first.type)) facts.codecString = dolbyVisionString(first.type, dv.profile, dv.level);
  return container || facts || dv ? resolve(codecName, container && { ...container, fullRange }, facts, dv, null) : null;
}

function matroskaColor(codecName: string, config: CodecConfig): ColorInfo | null | undefined {
  const mkv = matroskaConfig(config);
  if (!mkv) return undefined;
  const b = mkv.bytes;
  const container = matroskaColour(b, mkv.colour);
  let dv: DolbyVisionConfig | null = null;
  for (const m of mkv.mappings) {
    const extra = m.get(ID_BLOCK_ADD_ID_EXTRA_DATA);
    if (DOLBY_VISION_MAPPINGS.has(elementUint(b, m.get(ID_BLOCK_ADD_ID_TYPE)) ?? -1) && extra) dv = dolbyVision(b, extra) ?? dv;
  }
  const facts = matroskaConfigFacts(mkv.codecId, b, mkv.codecPrivate);
  const bits = elementUint(b, mkv.colour.get(ID_BITS_PER_CHANNEL));
  if (!container && !facts && !dv && !bits) return null;
  return resolve(codecName, container, facts, dv, bits ? bits : null);
}

export function colorOf(track: ColorTrack): ColorInfo | null | undefined {
  const config = track.codecConfig;
  if (!config) return undefined;
  return config.family === 'matroska' ? matroskaColor(track.codecName, config) : isoColor(track.codecName, config);
}

export function withColor<R extends Pick<FileResult, 'videoTracks'>>(result: R, options: { keepCodecConfig?: boolean } = {}): R {
  return {
    ...result,
    videoTracks: result.videoTracks.map((t) => {
      if (!t.codecConfig) return t;
      const out = { ...t, color: colorOf(t) };
      if (!options.keepCodecConfig) delete out.codecConfig;
      return out;
    }),
  };
}
