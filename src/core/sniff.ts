export type SniffKind = 'isobmff' | 'matroska' | 'unknown';

export interface SniffResult {
  kind: SniffKind;
  reason: string;
}

export const ISOBMFF_TOP_LEVEL_TYPES: ReadonlySet<string> = new Set([
  'ftyp',
  'moov',
  'mdat',
  'free',
  'skip',
  'wide',
  'pnot',
  'uuid',
  'moof',
  'styp',
  'sidx',
]);

export const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3] as const;

const OTHER_SIGNATURES: ReadonlyArray<{ bytes: readonly number[]; offset: number; label: string }> = [
  { bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], offset: 0, label: 'PNG image' },
  { bytes: [0xff, 0xd8, 0xff], offset: 0, label: 'JPEG image' },
  { bytes: [0x47, 0x49, 0x46, 0x38], offset: 0, label: 'GIF image' },
  { bytes: [0x52, 0x49, 0x46, 0x46], offset: 0, label: 'RIFF file (AVI/WAV/WebP)' },
  { bytes: [0x4f, 0x67, 0x67, 0x53], offset: 0, label: 'Ogg file' },
  { bytes: [0x46, 0x4c, 0x56, 0x01], offset: 0, label: 'FLV file' },
  { bytes: [0x00, 0x00, 0x01, 0xba], offset: 0, label: 'MPEG program stream' },
  { bytes: [0x25, 0x50, 0x44, 0x46], offset: 0, label: 'PDF document' },
  { bytes: [0x50, 0x4b, 0x03, 0x04], offset: 0, label: 'ZIP archive' },
  { bytes: [0x49, 0x44, 0x33], offset: 0, label: 'MP3 file' },
];

function matchAt(head: Uint8Array, bytes: readonly number[], offset: number): boolean {
  if (head.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (head[offset + i] !== bytes[i]) return false;
  return true;
}

function isPrintableType(head: Uint8Array): boolean {
  for (let i = 4; i < 8; i++) {
    const c = head[i];
    if (c < 0x20 || c > 0x7e) return false;
  }
  return true;
}

function looksLikeText(head: Uint8Array): boolean {
  const n = Math.min(head.length, 512);
  if (n === 0) return false;
  for (let i = 0; i < n; i++) {
    const c = head[i];
    if (c === 0x09 || c === 0x0a || c === 0x0d) continue;
    if (c < 0x20 || c === 0x7f) return false;
  }
  return true;
}

function describeUnknown(head: Uint8Array): string {
  for (const sig of OTHER_SIGNATURES) if (matchAt(head, sig.bytes, sig.offset)) return sig.label;
  if (head.length >= 188 && head[0] === 0x47 && head[188] === 0x47) return 'MPEG transport stream';
  if (looksLikeText(head)) return 'text file';
  return 'no known signature';
}

export function sniff(head: Uint8Array): SniffResult {
  if (head.length === 0) return { kind: 'unknown', reason: 'empty file' };
  if (matchAt(head, EBML_MAGIC, 0)) return { kind: 'matroska', reason: 'EBML header 1A45DFA3' };
  if (head.length >= 8 && isPrintableType(head)) {
    const type = String.fromCharCode(head[4], head[5], head[6], head[7]);
    if (ISOBMFF_TOP_LEVEL_TYPES.has(type)) {
      const size32 = head[0] * 0x1000000 + head[1] * 0x10000 + head[2] * 0x100 + head[3];
      if (size32 === 0) return { kind: 'isobmff', reason: `top-level '${type}' box running to end of file` };
      if (size32 >= 8) return { kind: 'isobmff', reason: `top-level '${type}' box` };
      if (size32 === 1) {
        if (head.length < 16) return { kind: 'unknown', reason: `'${type}' box with a truncated 64-bit size` };
        let large = 0;
        for (let i = 8; i < 16; i++) large = large * 256 + head[i];
        if (large >= 16) return { kind: 'isobmff', reason: `top-level '${type}' box with 64-bit size` };
      }
      return { kind: 'unknown', reason: `'${type}' box with invalid size ${size32}` };
    }
  }
  if (head.length < 8) return { kind: 'unknown', reason: `too small (${head.length} bytes)` };
  return { kind: 'unknown', reason: describeUnknown(head) };
}
