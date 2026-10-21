#!/usr/bin/env node
// Byte-level patcher that produces 64-bit-box ISO BMFF fixtures from small ffmpeg output (non-faststart: ftyp [wide|free] mdat moov).
// Usage:
//   node patch-mp4.mjs mdat64 <in> <out>               rewrite 'wide|free'(8) + 32-bit 'mdat' header into one 16-byte 64-bit mdat header (same file size, same offsets)
//   node patch-mp4.mjs co64   <in> <out>               additionally turn every stco into co64 (moov must be after mdat), also writes the 64-bit mdat header
//   node patch-mp4.mjs sparse <in> <out> <holeBytes>   build a sparse file: ftyp + 64-bit mdat(hole + payload) + moov with co64 offsets beyond 4 GiB
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const [mode, inFile, outFile, holeArg] = process.argv.slice(2);
const src = fs.readFileSync(inFile);

function topBoxes(buf) {
  const out = [];
  let pos = 0;
  while (pos + 8 <= buf.length) {
    let size = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    let hdr = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(pos + 8)); hdr = 16; } else if (size === 0) size = buf.length - pos;
    out.push({ type, pos, size, hdr });
    pos += size;
  }
  return out;
}

const CONT = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);

// Rebuild a box tree, converting stco -> co64 and shifting every chunk offset by `shift`.
function rebuild(buf, start, end, shift) {
  const parts = [];
  let pos = start;
  while (pos + 8 <= end) {
    const size = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + size);
    if (CONT.has(type)) {
      const inner = rebuild(buf, pos + 8, pos + size, shift);
      const h = Buffer.alloc(8);
      h.writeUInt32BE(inner.length + 8, 0);
      h.write(type, 4, 'latin1');
      parts.push(h, inner);
    } else if (type === 'stco') {
      const count = body.readUInt32BE(4);
      const nb = Buffer.alloc(8 + 8 + count * 8);
      nb.writeUInt32BE(nb.length, 0);
      nb.write('co64', 4, 'latin1');
      nb.writeUInt32BE(count, 12);
      for (let i = 0; i < count; i++) nb.writeBigUInt64BE(BigInt(body.readUInt32BE(8 + i * 4)) + BigInt(shift), 16 + i * 8);
      parts.push(nb);
    } else {
      parts.push(buf.subarray(pos, pos + size));
    }
    pos += size;
  }
  return Buffer.concat(parts);
}

const boxes = topBoxes(src);
const iMdat = boxes.findIndex((b) => b.type === 'mdat');
const mdat = boxes[iMdat];
const pad = boxes[iMdat - 1];
const moov = boxes.find((b) => b.type === 'moov');
if (!mdat || mdat.hdr !== 8 || !pad || pad.size !== 8 || (pad.type !== 'wide' && pad.type !== 'free')) {
  console.error('input is not ftyp [wide|free] mdat(32-bit) layout; got ' + boxes.map((b) => b.type).join(' '));
  process.exit(1);
}
if (moov.pos < mdat.pos) {
  console.error('moov is before mdat (faststart) - not supported by this patcher');
  process.exit(1);
}

function hdr64(totalSize) {
  const h = Buffer.alloc(16);
  h.writeUInt32BE(1, 0);
  h.write('mdat', 4, 'latin1');
  h.writeBigUInt64BE(BigInt(totalSize), 8);
  return h;
}

if (mode === 'mdat64' || mode === 'co64') {
  const out = Buffer.from(src);
  hdr64(mdat.size + 8).copy(out, pad.pos);
  let final = out;
  if (mode === 'co64') {
    const moovBuf = rebuild(src, moov.pos, moov.pos + moov.size, 0);
    final = Buffer.concat([out.subarray(0, moov.pos), moovBuf, out.subarray(moov.pos + moov.size)]);
  }
  fs.writeFileSync(outFile, final);
  console.log(`${mode}: wrote ${outFile} (${final.length} bytes, was ${src.length})`);
} else if (mode === 'sparse') {
  const hole = Number(holeArg);
  const ftyp = src.subarray(0, pad.pos);
  const payload = src.subarray(mdat.pos + 8, mdat.pos + mdat.size);
  const p0 = mdat.pos + 8;
  const p1 = ftyp.length + 16 + hole;
  const moovBuf = rebuild(src, moov.pos, moov.pos + moov.size, p1 - p0);
  fs.writeFileSync(outFile, ftyp);
  const sp = spawnSync('fsutil', ['sparse', 'setflag', outFile], { encoding: 'utf8' });
  const fd = fs.openSync(outFile, 'r+');
  fs.writeSync(fd, hdr64(16 + hole + payload.length), 0, 16, ftyp.length);
  fs.writeSync(fd, payload, 0, payload.length, p1);
  fs.writeSync(fd, moovBuf, 0, moovBuf.length, p1 + payload.length);
  fs.closeSync(fd);
  const st = fs.statSync(outFile);
  console.log(`sparse: wrote ${outFile} logical ${st.size} bytes (fsutil exit ${sp.status}: ${(sp.stdout || sp.stderr || '').trim()}); moov at ${p1 + payload.length}, payload at ${p1}`);
} else {
  console.error('unknown mode');
  process.exit(2);
}
