export interface Edit {
  duration: number;
  mediaTime: number;
  rate: number;
}

export interface TableRef {
  start: number;
  end: number;
}

export interface Fragment {
  moofIndex: number;
  baseDts: number | null;
  count: number;
  durations: Uint32Array | null;
  defaultDuration: number;
  cts: Int32Array | null;
  durationSum: number;
  present: number;
  complete: number;
  trexMissing: boolean;
  overrun: boolean;
}

export interface Trex {
  duration: number;
  size: number;
}

export interface IsoTrack {
  id: number;
  enabled: boolean;
  handler: string;
  timescale: number;
  hasMdhd: boolean;
  mdhdDuration: number;
  matrix: Int32Array;
  sampleEntry: string;
  originalFormat: string | null;
  stsdCount: number;
  width: number;
  height: number;
  esdsObjectType: number | null;
  hasHvcc: boolean;
  sttsCounts: Uint32Array;
  sttsDeltas: Uint32Array;
  cttsCounts: Uint32Array | null;
  cttsOffsets: Int32Array | null;
  dtsShift: number;
  sampleCount: number | null;
  sampleSize: number;
  overruns: string[];
  edits: Edit[];
  fragments: Fragment[];
  warnings: string[];
  dv: DataView | null;
  stss: TableRef | null;
  stsz: TableRef | null;
  stz2: TableRef | null;
  stsc: TableRef | null;
  stco: TableRef | null;
  co64: TableRef | null;
}

export interface Sidx {
  start: number;
  end: number;
  referenceId: number;
  timescale: number;
  earliestPts: number;
  firstOffset: number;
  coverageEnd: number;
  durationSum: number;
  subsegments: Array<[offset: number, size: number]>;
  hierarchical: boolean;
}

export interface TopBox {
  type: string;
  start: number;
  end: number;
  sidx: Sidx | null;
}

export interface IsoMovie {
  fileSize: number;
  brand: string | null;
  compatibleBrands: string[];
  hasFtyp: boolean;
  hasMvhd: boolean;
  timescale: number;
  duration: number;
  matrix: Int32Array;
  tracks: IsoTrack[];
  chapterTrackIds: Set<number>;
  hasMvex: boolean;
  trex: Map<number, Trex>;
  moofCount: number;
  topLevel: TopBox[];
  moov?: [offset: number, size: number];
  truncated: boolean;
  ffprobeMoofLimit: number;
  ffprobeReject: { moof: number; reason: string } | null;
  warnings: string[];
}

export const TO_MEDIA_END = Number.MAX_SAFE_INTEGER;

export const IDENTITY_MATRIX: readonly number[] = [65536, 0, 0, 0, 65536, 0, 0, 0, 1 << 30];

export function newMovie(fileSize: number): IsoMovie {
  return {
    fileSize,
    brand: null,
    compatibleBrands: [],
    hasFtyp: false,
    hasMvhd: false,
    timescale: 1,
    duration: 0,
    matrix: Int32Array.from(IDENTITY_MATRIX),
    tracks: [],
    chapterTrackIds: new Set(),
    hasMvex: false,
    trex: new Map(),
    moofCount: 0,
    topLevel: [],
    truncated: false,
    ffprobeMoofLimit: Infinity,
    ffprobeReject: null,
    warnings: [],
  };
}

export function newTrack(): IsoTrack {
  return {
    id: 0,
    enabled: false,
    handler: '',
    timescale: 0,
    hasMdhd: false,
    mdhdDuration: 0,
    matrix: Int32Array.from(IDENTITY_MATRIX),
    sampleEntry: '',
    originalFormat: null,
    stsdCount: 0,
    width: 0,
    height: 0,
    esdsObjectType: null,
    hasHvcc: false,
    sttsCounts: new Uint32Array(0),
    sttsDeltas: new Uint32Array(0),
    cttsCounts: null,
    cttsOffsets: null,
    dtsShift: 0,
    sampleCount: null,
    sampleSize: 0,
    overruns: [],
    edits: [],
    fragments: [],
    warnings: [],
    dv: null,
    stss: null,
    stsz: null,
    stz2: null,
    stsc: null,
    stco: null,
    co64: null,
  };
}
