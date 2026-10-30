#!/usr/bin/env node
// Byte patcher that turns an ffmpeg-written WebM into MediaRecorder-like variants.
// Usage:
//   node patch-webm.mjs unknown-clusters <in> <out>   set every 8-byte Cluster size to "unknown" (01 FF FF FF FF FF FF FF)
//   node patch-webm.mjs void-defaultduration <in> <out> overwrite the DefaultDuration element with an EBML Void element of equal length
//   node patch-webm.mjs dvmap <in> <out> <p,l,c,m>     add a Dolby Vision BlockAdditionMapping (name, dvcC or dvvC type, 24-byte record with version 1.0,
//                                                      profile, level, rpu and bl set, compatibility id, metadata compression) to the first video TrackEntry
//                                                      where ffmpeg writes it, taking the bytes from the Void after the SeekHead so that no Cluster moves
import fs from 'node:fs';
import zlib from 'node:zlib';

const [mode, inFile, outFile, valueArg] = process.argv.slice(2);
const buf = Buffer.from(fs.readFileSync(inFile));
let patched = 0;

const SEGMENT = 0x18538067;
const SEEK_HEAD = 0x114d9b74;
const SEEK = 0x4dbb;
const SEEK_POSITION = 0x53ac;
const TRACKS = 0x1654ae6b;
const TRACK_ENTRY = 0xae;
const TRACK_TYPE = 0x83;
const VOID = 0xec;
const CRC32 = 0xbf;

const vintLength = (first) => (first === 0 ? 9 : Math.clz32(first) - 23);

function elementAt(b, p) {
  const idLength = vintLength(b[p]);
  let id = 0;
  for (let i = 0; i < idLength; i++) id = id * 256 + b[p + i];
  const sizeLength = vintLength(b[p + idLength]);
  if (idLength > 4 || sizeLength > 8) throw new Error(`no EBML element at ${p}`);
  let size = b[p + idLength] & (0xff >> sizeLength);
  for (let i = 1; i < sizeLength; i++) size = size * 256 + b[p + idLength + i];
  const data = p + idLength + sizeLength;
  return { id, start: p, sizeAt: p + idLength, sizeLength, data, size, end: data + size };
}

function childrenOf(b, start, end) {
  const out = [];
  for (let p = start; p < end; ) {
    const e = elementAt(b, p);
    if (e.end > end) throw new Error(`element ${e.id.toString(16)} at ${p} ends past its parent`);
    out.push(e);
    p = e.end;
  }
  return out;
}

function writeSize(b, at, length, value) {
  if (value >= 2 ** (7 * length) - 1) throw new Error(`size ${value} does not fit ${length} bytes`);
  for (let i = length - 1; i >= 0; i--, value = Math.floor(value / 256)) b[at + i] = value & 0xff;
  b[at] |= 0x80 >> (length - 1);
}

function element(id, payload) {
  const idBytes = Buffer.from(id.toString(16).padStart(id > 0xffffff ? 8 : id > 0xffff ? 6 : id > 0xff ? 4 : 2, '0'), 'hex');
  const size = Buffer.alloc(1);
  writeSize(size, 0, 1, payload.length);
  return Buffer.concat([idBytes, size, payload]);
}

function uintElement(id, value, length) {
  const b = Buffer.alloc(length);
  b.writeUIntBE(value, 0, length);
  return element(id, b);
}

function fixCrc(b, master) {
  const first = childrenOf(b, master.data, master.end)[0];
  if (first?.id !== CRC32 || first.size !== 4) return;
  b.writeUInt32LE(zlib.crc32(b.subarray(first.end, master.end)), first.data);
}

function dvMapping(spec) {
  const [profile, level, compatibility, mdCompression] = spec.split(',').map(Number);
  const record = Buffer.alloc(24);
  record.writeUInt8(1, 0);
  record.writeUInt16BE((profile << 9) | (level << 3) | 0b101, 2);
  record.writeUInt8((compatibility << 4) | (mdCompression << 2), 4);
  const type = Buffer.from(profile > 7 ? 'dvvC' : 'dvcC', 'latin1').readUInt32BE(0);
  return element(0x41e4, Buffer.concat([element(0x41a4, Buffer.from('Dolby Vision configuration', 'latin1')), uintElement(0x41e7, type, 4), element(0x41ed, record)]));
}

function addDvMapping(spec) {
  const segment = childrenOf(buf, 0, buf.length).find((e) => e.id === SEGMENT);
  if (!segment) throw new Error('no Segment');
  const level1 = childrenOf(buf, segment.data, Math.min(segment.end, buf.length));
  const tracks = level1.find((e) => e.id === TRACKS);
  const room = level1.find((e) => e.id === VOID && tracks && e.end <= tracks.start);
  const seekHead = level1.find((e) => e.id === SEEK_HEAD);
  if (!tracks || !room || !seekHead) throw new Error('needs a SeekHead, a Void before Tracks and Tracks');
  const entry = childrenOf(buf, tracks.data, tracks.end).find((e) => e.id === TRACK_ENTRY && childrenOf(buf, e.data, e.end).some((c) => c.id === TRACK_TYPE && buf[c.data] === 1));
  if (!entry) throw new Error('no video TrackEntry');
  const kids = childrenOf(buf, entry.data, entry.end);
  const placeholder = kids.find((c) => c.id === VOID);
  const insertAt = placeholder ? placeholder.end : (kids.find((c) => c.id === 0x63a2)?.start ?? entry.end);
  const mapping = dvMapping(spec);
  const shift = mapping.length;
  if (room.size < shift) throw new Error(`the Void has ${room.size} bytes, the mapping needs ${shift}`);
  const head = Buffer.from(buf.subarray(0, room.data));
  writeSize(head, room.sizeAt, room.sizeLength, room.size - shift);
  const out = Buffer.concat([head, Buffer.alloc(room.size - shift), buf.subarray(room.end, insertAt), mapping, buf.subarray(insertAt)]);
  writeSize(out, tracks.sizeAt - shift, tracks.sizeLength, tracks.size + shift);
  writeSize(out, entry.sizeAt - shift, entry.sizeLength, entry.size + shift);
  for (const seek of childrenOf(out, seekHead.data, seekHead.end).filter((e) => e.id === SEEK)) {
    const position = childrenOf(out, seek.data, seek.end).find((e) => e.id === SEEK_POSITION);
    const target = position ? segment.data + out.readUIntBE(position.data, position.size) : -1;
    if (position && target >= room.end && target <= tracks.start) out.writeUIntBE(target - shift - segment.data, position.data, position.size);
  }
  fixCrc(out, elementAt(out, seekHead.start));
  fixCrc(out, elementAt(out, tracks.start - shift));
  return out;
}

if (mode === 'dvmap') {
  if (!valueArg) throw new Error('dvmap needs p,l,c,m');
  const out = addDvMapping(valueArg);
  fs.writeFileSync(outFile, out);
  console.log(`${mode}: wrote ${outFile} (${out.length} bytes, was ${buf.length})`);
  process.exit(0);
}

if (mode === 'unknown-clusters') {
  const CLUSTER = Buffer.from([0x1f, 0x43, 0xb6, 0x75]);
  let i = 0;
  while ((i = buf.indexOf(CLUSTER, i)) !== -1) {
    const b0 = buf[i + 4];
    let len = 1;
    while (len <= 8 && !(b0 & (0x80 >> (len - 1)))) len++;
    if (len <= 8) {
      buf[i + 4] = 0xff >> (len - 1);
      for (let k = 1; k < len; k++) buf[i + 4 + k] = 0xff;
      patched++;
    }
    i += 4;
  }
} else if (mode === 'void-defaultduration') {
  const DD = Buffer.from([0x23, 0xe3, 0x83]);
  const i = buf.indexOf(DD);
  if (i !== -1) {
    const dataLen = buf[i + 3] & 0x7f;
    const total = 3 + 1 + dataLen;
    buf[i] = 0xec;
    buf[i + 1] = 0x80 | (total - 2);
    buf.fill(0, i + 2, i + total);
    patched++;
  }
} else {
  console.error('unknown mode');
  process.exit(2);
}
fs.writeFileSync(outFile, buf);
console.log(`${mode}: patched ${patched} element(s) -> ${outFile}`);
