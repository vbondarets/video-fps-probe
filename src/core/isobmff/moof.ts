import { u24 } from '../reader.ts';
import { boundEntries, boxU64, childBoxes, IsoBmffError, type BoxHeader } from './boxes.ts';
import type { Fragment, IsoMovie, IsoTrack, Sidx } from './model.ts';

export const TFHD_BASE_DATA_OFFSET = 0x1;
export const TFHD_SAMPLE_DESCRIPTION_INDEX = 0x2;
export const TFHD_DEFAULT_DURATION = 0x8;
export const TFHD_DEFAULT_SIZE = 0x10;
export const TFHD_DEFAULT_BASE_IS_MOOF = 0x20000;

const NO_TREX = 'no trex: sample defaults taken from tfhd';

export const TRUN_DATA_OFFSET = 0x1;
export const TRUN_FIRST_SAMPLE_FLAGS = 0x4;
export const TRUN_SAMPLE_DURATION = 0x100;
export const TRUN_SAMPLE_SIZE = 0x200;
export const TRUN_SAMPLE_FLAGS = 0x400;
export const TRUN_SAMPLE_CTS = 0x800;

export interface Tfhd {
  flags: number;
  trackId: number;
  baseDataOffset: number;
  defaultDuration: number | null;
  defaultSize: number;
  trexMissing: boolean;
}

export function trunRecordSize(flags: number): number {
  let n = 0;
  for (let bit = 0x100; bit <= 0x800; bit <<= 1) if (flags & bit) n += 4;
  return n;
}

export function parseTfhd(dv: DataView, p: number, end: number, movie: IsoMovie, moofStart: number, implicitOffset: number, boxAt = moofStart + p - 8): Tfhd | null {
  if (p + 8 > end) return null;
  const flags = u24(dv, p + 1);
  const trackId = dv.getUint32(p + 4);
  const trex = movie.trex.get(trackId);
  let o = p + 8;
  const need = (n: number): boolean => o + n <= end;
  let baseDataOffset = flags & TFHD_DEFAULT_BASE_IS_MOOF ? moofStart : implicitOffset;
  if (flags & TFHD_BASE_DATA_OFFSET) {
    if (!need(8)) return null;
    baseDataOffset = boxU64(dv, o, 'tfhd', boxAt);
    o += 8;
  }
  if (flags & TFHD_SAMPLE_DESCRIPTION_INDEX) o += 4;
  let defaultDuration = trex ? trex.duration : null;
  if (flags & TFHD_DEFAULT_DURATION) {
    if (!need(4)) return null;
    defaultDuration = dv.getUint32(o);
    o += 4;
  }
  let defaultSize = trex ? trex.size : 0;
  if (flags & TFHD_DEFAULT_SIZE) {
    if (!need(4)) return null;
    defaultSize = dv.getUint32(o);
  }
  return { flags, trackId, baseDataOffset, defaultDuration, defaultSize, trexMissing: !trex };
}

export interface TrunResult {
  fragment: Fragment;
  dataEnd: number;
}

export function parseTrun(
  dv: DataView,
  p: number,
  end: number,
  tfhd: Tfhd,
  dataStartDefault: number,
  fileSize: number,
  warnings: string[],
  maxSamples: number,
): TrunResult {
  const flags = u24(dv, p + 1);
  const declared = dv.getUint32(p + 4);
  let o = p + 8;
  let dataStart = dataStartDefault;
  if (flags & TRUN_DATA_OFFSET) {
    dataStart = tfhd.baseDataOffset + dv.getInt32(o);
    o += 4;
  }
  if (flags & TRUN_FIRST_SAMPLE_FLAGS) o += 4;
  const record = trunRecordSize(flags);
  let count: number;
  if (record > 0) {
    count = boundEntries(declared, end - o, record, 'trun', warnings);
  } else {
    count = declared;
    if (count > maxSamples) {
      warnings.push(`trun count ${declared} limited to ${maxSamples}`);
      count = maxSamples;
    }
  }
  const overrun = record > 0 && count < declared;
  const hasDuration = (flags & TRUN_SAMPLE_DURATION) !== 0;
  if (!hasDuration && tfhd.defaultDuration === null && count > 0) {
    throw new IsoBmffError('corrupt', `corrupt file: no sample duration for track ${tfhd.trackId}`);
  }
  const defaultDuration = tfhd.defaultDuration ?? 0;
  const durations = hasDuration ? new Uint32Array(count) : null;
  const cts = flags & TRUN_SAMPLE_CTS ? new Int32Array(count) : null;
  const hasSize = (flags & TRUN_SAMPLE_SIZE) !== 0;
  let durationSum = hasDuration ? 0 : defaultDuration * count;
  let pos = dataStart;
  let present = 0;
  let complete = 0;
  if (record > 0) {
    for (let i = 0; i < count; i++) {
      if (hasDuration) {
        const d = dv.getUint32(o);
        durations![i] = d;
        durationSum += d;
        o += 4;
      }
      let size = tfhd.defaultSize;
      if (hasSize) {
        size = dv.getUint32(o);
        o += 4;
      }
      if (flags & TRUN_SAMPLE_FLAGS) o += 4;
      if (cts) {
        cts[i] = dv.getInt32(o);
        o += 4;
      }
      if (pos < fileSize) present++;
      if (complete === i && pos + size <= fileSize) complete++;
      pos += size;
    }
  }
  if (!hasSize) {
    const size = tfhd.defaultSize;
    const room = Math.max(0, fileSize - dataStart);
    present = size > 0 ? Math.min(count, Math.ceil(room / size)) : Math.min(count, room);
    complete = size > 0 ? Math.min(count, Math.floor(room / size)) : present;
    pos = dataStart + size * count;
  }
  const fragment: Fragment = {
    moofIndex: 0,
    baseDts: null,
    count,
    durations,
    defaultDuration,
    cts,
    durationSum,
    present,
    complete,
    trexMissing: tfhd.trexMissing,
    overrun,
  };
  return { fragment, dataEnd: pos };
}

export function parseMoof(dv: DataView, moof: BoxHeader, moofStart: number, moofIndex: number, movie: IsoMovie, maxSamples: number): void {
  let implicitOffset = moofStart;
  let foundTfhd = false;
  const reject = (reason: string): void => {
    if (!movie.ffprobeReject) movie.ffprobeReject = { moof: moofIndex, reason };
  };
  const byId = new Map<number, IsoTrack>();
  for (const t of movie.tracks) if (!byId.has(t.id)) byId.set(t.id, t);
  for (const traf of childBoxes(dv, moof.start + moof.headerSize, moof.end, movie.warnings)) {
    if (traf.type !== 'traf') continue;
    let tfhd: Tfhd | null = null;
    let track: IsoTrack | undefined;
    let baseDts: number | null = null;
    let dataCursor = 0;
    for (const c of childBoxes(dv, traf.start + traf.headerSize, traf.end, movie.warnings)) {
      const p = c.start + c.headerSize;
      if (c.type === 'tfhd') {
        tfhd = parseTfhd(dv, p, c.end, movie, moofStart, implicitOffset, moofStart + c.start);
        if (!tfhd) continue;
        if (tfhd.trackId === 0) reject('rejects this file: tfhd with track_ID 0');
        else if (!tfhd.trexMissing) foundTfhd = true;
        dataCursor = tfhd.baseDataOffset;
        track = byId.get(tfhd.trackId);
        if (!track) movie.warnings.push(`fragment for unknown track ${tfhd.trackId}`);
      } else if (c.type === 'tfdt' && p + 8 <= c.end) {
        baseDts = dv.getUint8(p) === 1 && p + 12 <= c.end ? boxU64(dv, p + 4, 'tfdt', moofStart + c.start) : dv.getUint32(p + 4);
      } else if (c.type === 'trun' && p + 8 <= c.end) {
        if (!foundTfhd) reject('rejects this file: trun without a tfhd that has a trex');
        else if (!tfhd || tfhd.trexMissing) reject('misreads this file: a traf without trex is read as another track');
        if (!tfhd || !track) continue;
        const target = track;
        const { fragment, dataEnd } = parseTrun(dv, p, c.end, tfhd, dataCursor, movie.fileSize, target.warnings, maxSamples);
        fragment.moofIndex = moofIndex;
        fragment.baseDts = baseDts;
        baseDts = null;
        dataCursor = dataEnd;
        implicitOffset = dataEnd;
        if (fragment.trexMissing && !target.warnings.includes(NO_TREX)) target.warnings.push(NO_TREX);
        target.fragments.push(fragment);
      }
    }
  }
}

export function parseSidx(dv: DataView, box: BoxHeader, fileStart: number): Sidx | null {
  const p = box.start + box.headerSize;
  const v1 = p < box.end && dv.getUint8(p) === 1;
  if (p + (v1 ? 32 : 24) > box.end) throw new IsoBmffError('corrupt', `corrupt file: box 'sidx' at ${fileStart} is truncated`);
  let o = p + 12;
  const earliestPts = v1 ? boxU64(dv, o, 'sidx', fileStart) : dv.getUint32(o);
  const firstOffset = v1 ? boxU64(dv, o + 8, 'sidx', fileStart) : dv.getUint32(o + 4);
  o += v1 ? 16 : 8;
  const count = dv.getUint16(o + 2);
  o += 4;
  const end = fileStart + (box.end - box.start);
  let offset = end + firstOffset;
  let durationSum = 0;
  let hierarchical = false;
  const subsegments: Array<[number, number]> = [];
  for (let i = 0; i < count && o + 12 <= box.end; i++, o += 12) {
    const word = dv.getUint32(o);
    if (word & 0x80000000) hierarchical = true;
    const size = word & 0x7fffffff;
    subsegments.push([offset, size]);
    offset += size;
    durationSum += dv.getUint32(o + 4);
  }
  return {
    start: fileStart,
    end,
    referenceId: dv.getUint32(p + 4),
    timescale: dv.getUint32(p + 8),
    earliestPts,
    firstOffset,
    coverageEnd: offset,
    durationSum,
    subsegments,
    hierarchical,
  };
}
