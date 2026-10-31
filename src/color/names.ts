const PRIMARIES = 'reserved|bt709|unknown|reserved|bt470m|bt470bg|smpte170m|smpte240m|film|bt2020|smpte428|smpte431|smpte432||||||||||ebu3213'.split('|');

const TRANSFERS = 'reserved|bt709|unknown|reserved|bt470m|bt470bg|smpte170m|smpte240m|linear|log100|log316|iec61966-2-4|bt1361e|iec61966-2-1|bt2020-10|bt2020-12|smpte2084|smpte428|arib-std-b67'.split('|');

const MATRICES = 'gbr|bt709|unknown|reserved|fcc|bt470bg|smpte170m|smpte240m|ycgco|bt2020nc|bt2020c|smpte2085|chroma-derived-nc|chroma-derived-c|ictcp|ipt-c2|ycgco-re|ycgco-ro'.split('|');

const EXTENDED_BASE = 256;

export type ColorMember = 'primaries' | 'transfer' | 'space';

const TABLES: Record<ColorMember, { base: readonly string[]; extended: readonly string[] }> = {
  primaries: { base: PRIMARIES, extended: ['vgamut'] },
  transfer: { base: TRANSFERS, extended: ['vlog'] },
  space: { base: MATRICES, extended: [] },
};

export const UNSPECIFIED = 2;

export const VUI_RULE = {
  h264: { colour: 'container-first', range: 'container-first' },
  hevc: { colour: 'container-first', range: 'container-first' },
} as const;

function nameOf(member: ColorMember, code: number): string | undefined {
  const table = TABLES[member];
  return (code >= EXTENDED_BASE ? table.extended[code - EXTENDED_BASE] : table.base[code]) || undefined;
}

export function colorName(member: ColorMember, code: number | null): string | null {
  if (code === null || code === UNSPECIFIED) return null;
  return nameOf(member, code) ?? null;
}

export function namedOrUnspecified(member: ColorMember, code: number): number {
  return nameOf(member, code) === undefined ? UNSPECIFIED : code;
}

export type ColorCodes = [primaries: number, transfer: number, matrix: number];

const MEMBERS: readonly ColorMember[] = ['primaries', 'transfer', 'space'];

export function namedCodes(codes: readonly number[]): ColorCodes {
  return MEMBERS.map((m, i) => namedOrUnspecified(m, codes[i])) as ColorCodes;
}

export function colorNames(codes: ColorCodes | null): [primaries: string | null, transfer: string | null, space: string | null] {
  return codes ? (MEMBERS.map((m, i) => colorName(m, codes[i])) as [string | null, string | null, string | null]) : [null, null, null];
}
