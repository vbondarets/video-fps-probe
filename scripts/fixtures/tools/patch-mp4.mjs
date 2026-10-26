#!/usr/bin/env node
// Byte-level patcher that produces 64-bit-box and malformed-header ISO BMFF fixtures from small ffmpeg output.
// Usage:
//   node patch-mp4.mjs mdat64 <in> <out>               rewrite 'wide|free'(8) + 32-bit 'mdat' header into one 16-byte 64-bit mdat header (same file size, same offsets)
//   node patch-mp4.mjs co64   <in> <out>               additionally turn every stco into co64 (moov must be after mdat), also writes the 64-bit mdat header
//   node patch-mp4.mjs sparse <in> <out> <holeBytes>   build a sparse file: ftyp + 64-bit mdat(hole + payload) + moov with co64 offsets beyond 4 GiB
//   node patch-mp4.mjs mehd   <in> <out> <hex64>       append a version 1 'mehd' holding the 64-bit value to mvex (moof-relative data offsets; tfra offsets are shifted)
//   node patch-mp4.mjs elst64 <in> <out> <hex64>       rewrite the first elst as version 1 and set the segment duration of its first media edit (moov after mdat)
//   node patch-mp4.mjs mvhd64|tkhd64|mdhd64 <in> <out> <hex64>  rewrite the first mvhd, tkhd or mdhd as version 1 with the 64-bit duration (moov after mdat)
//   node patch-mp4.mjs trailer <in> <out> <hex>        append the bytes after the last top-level box
//   node patch-mp4.mjs stsd2  <in> <out> <WxH>         add a copy of the only sample entry with the size WxH and point the second half of the samples to it (one chunk split in two; moov after mdat)
// The first three modes need the non-faststart layout ftyp [wide|free] mdat moov.
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
const EDIT_CONT = new Set(['moov', 'trak', 'edts', 'mvex', 'mdia', 'minf', 'stbl']);

// Rebuild a box tree, replacing leaf boxes through `leaf` and appending the boxes `extra` returns to a container.
function edit(buf, start, end, leaf, extra) {
  const parts = [];
  let pos = start;
  while (pos + 8 <= end) {
    const size = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    if (size < 8) throw new Error(`box '${type}' at ${pos} has size ${size}`);
    if (EDIT_CONT.has(type)) {
      const inner = Buffer.concat([edit(buf, pos + 8, pos + size, leaf, extra), ...(extra(type) ?? [])]);
      const h = Buffer.alloc(8);
      h.writeUInt32BE(inner.length + 8, 0);
      h.write(type, 4, 'latin1');
      parts.push(h, inner);
    } else {
      parts.push(leaf(type, buf.subarray(pos, pos + size)) ?? buf.subarray(pos, pos + size));
    }
    pos += size;
  }
  return Buffer.concat(parts);
}

function fullBox(type, version, payload) {
  const b = Buffer.alloc(12 + payload.length);
  b.writeUInt32BE(b.length, 0);
  b.write(type, 4, 'latin1');
  b.writeUInt8(version, 8);
  payload.copy(b, 12);
  return b;
}

function u64(hex) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt('0x' + hex), 0);
  return b;
}

function shiftTfra(buf, delta) {
  const mfra = topBoxes(buf).find((b) => b.type === 'mfra');
  if (!mfra) return;
  for (let p = mfra.pos + 8; p + 8 <= mfra.pos + mfra.size; p += buf.readUInt32BE(p)) {
    if (buf.toString('latin1', p + 4, p + 8) !== 'tfra') continue;
    const v1 = buf.readUInt8(p + 8) === 1;
    const sizes = buf.readUInt32BE(p + 16);
    const tail = (((sizes >> 4) & 3) + 1) + (((sizes >> 2) & 3) + 1) + ((sizes & 3) + 1);
    const n = buf.readUInt32BE(p + 20);
    for (let i = 0, q = p + 24; i < n; i++, q += (v1 ? 16 : 8) + tail) {
      if (v1) buf.writeBigUInt64BE(buf.readBigUInt64BE(q + 8) + BigInt(delta), q + 8);
      else buf.writeUInt32BE(buf.readUInt32BE(q + 4) + delta, q + 4);
    }
  }
}

function replaceMoov(buf, moovBuf) {
  const moov = topBoxes(buf).find((b) => b.type === 'moov');
  return Buffer.concat([buf.subarray(0, moov.pos), moovBuf, buf.subarray(moov.pos + moov.size)]);
}

function splitSampleEntry(box, type, state, [width, height]) {
  if (type === 'stsd') {
    if (box.readUInt32BE(12) !== 1) throw new Error('stsd has more than one entry');
    const entry = box.subarray(16, 16 + box.readUInt32BE(16));
    const copy = Buffer.from(entry);
    copy.writeUInt16BE(width, 32);
    copy.writeUInt16BE(height, 34);
    const out = Buffer.concat([box.subarray(0, 16 + entry.length), copy, box.subarray(16 + entry.length)]);
    out.writeUInt32BE(out.length, 0);
    out.writeUInt32BE(2, 12);
    return out;
  }
  if (type === 'stsz') {
    if (box.readUInt32BE(12) !== 0) throw new Error('stsz has a constant sample size');
    state.sizes = Array.from({ length: box.readUInt32BE(16) }, (_, i) => box.readUInt32BE(20 + i * 4));
  } else if (type === 'stsc') {
    if (box.readUInt32BE(12) !== 1 || box.readUInt32BE(16) !== 1) throw new Error('stsc is not one run from chunk 1');
    state.first = Math.floor(box.readUInt32BE(20) / 2);
    const out = Buffer.alloc(40);
    out.writeUInt32BE(40, 0);
    out.write('stsc', 4, 'latin1');
    out.writeUInt32BE(2, 12);
    [1, state.first, 1, 2, box.readUInt32BE(20) - state.first, 2].forEach((v, i) => out.writeUInt32BE(v, 16 + i * 4));
    return out;
  } else if (type === 'stco') {
    if (box.readUInt32BE(12) !== 1 || !state.sizes) throw new Error('stco is not one chunk after stsz');
    const offset = box.readUInt32BE(16);
    const out = Buffer.alloc(24);
    out.writeUInt32BE(24, 0);
    out.write('stco', 4, 'latin1');
    out.writeUInt32BE(2, 12);
    out.writeUInt32BE(offset, 16);
    out.writeUInt32BE(offset + state.sizes.slice(0, state.first).reduce((a, b) => a + b, 0), 20);
    return out;
  }
  return null;
}

if (mode === 'stsd2') {
  const top = topBoxes(src);
  const moov = top.find((b) => b.type === 'moov');
  if (moov.pos < top.find((b) => b.type === 'mdat').pos) throw new Error('moov is before mdat (faststart): chunk offsets would move');
  const state = {};
  const moovBuf = edit(src, moov.pos, moov.pos + moov.size, (type, box) => splitSampleEntry(box, type, state, holeArg.split('x').map(Number)), () => null);
  if (!state.first) throw new Error('no sample tables');
  const final = replaceMoov(src, moovBuf);
  fs.writeFileSync(outFile, final);
  console.log(`${mode}: wrote ${outFile} (${final.length} bytes, was ${src.length})`);
  process.exit(0);
}

if (mode === 'mvhd64' || mode === 'tkhd64' || mode === 'mdhd64') {
  const target = mode.slice(0, 4);
  const top = topBoxes(src);
  const moov = top.find((b) => b.type === 'moov');
  if (moov.pos < top.find((b) => b.type === 'mdat').pos) throw new Error('moov is before mdat (faststart): chunk offsets would move');
  let done = false;
  const moovBuf = edit(src, moov.pos, moov.pos + moov.size, (type, box) => {
    if (type !== target || done) return null;
    done = true;
    if (box.readUInt8(8) !== 0) throw new Error(`${type} is not version 0`);
    const before = type === 'tkhd' ? 8 : 4;
    const out = Buffer.alloc(box.length + 12);
    out.writeUInt32BE(out.length, 0);
    out.write(type, 4, 'latin1');
    out.writeUInt32BE(0x01000000 | box.readUIntBE(9, 3), 8);
    out.writeBigUInt64BE(BigInt(box.readUInt32BE(12)), 12);
    out.writeBigUInt64BE(BigInt(box.readUInt32BE(16)), 20);
    box.copy(out, 28, 20, 20 + before);
    out.writeBigUInt64BE(BigInt('0x' + holeArg), 28 + before);
    box.copy(out, 36 + before, 24 + before);
    return out;
  }, () => null);
  if (!done) throw new Error(`no ${target}`);
  const final = replaceMoov(src, moovBuf);
  fs.writeFileSync(outFile, final);
  console.log(`${mode}: wrote ${outFile} (${final.length} bytes, was ${src.length})`);
  process.exit(0);
}

if (mode === 'mehd' || mode === 'elst64' || mode === 'trailer') {
  const top = topBoxes(src);
  const moov = top.find((b) => b.type === 'moov');
  let final;
  if (mode === 'trailer') {
    final = Buffer.concat([src, Buffer.from(holeArg, 'hex')]);
  } else if (mode === 'mehd') {
    if (top.some((b) => b.type === 'sidx' && b.pos < moov.pos)) throw new Error('a sidx before moov would point past its subsegments');
    const mehd = fullBox('mehd', 1, u64(holeArg));
    let added = 0;
    const moovBuf = edit(src, moov.pos, moov.pos + moov.size, () => null, (type) => (type === 'mvex' && ++added ? [mehd] : null));
    if (added !== 1) throw new Error('no mvex');
    for (const b of top.filter((x) => x.type === 'moof')) {
      const tf = src.indexOf('tfhd', b.pos);
      if (tf < 0 || src.readUInt32BE(tf + 4) & 1) throw new Error(`moof at ${b.pos} has an absolute base_data_offset`);
    }
    final = replaceMoov(src, moovBuf);
    shiftTfra(final, moovBuf.length - moov.size);
  } else {
    if (moov.pos < top.find((b) => b.type === 'mdat').pos) throw new Error('moov is before mdat (faststart): chunk offsets would move');
    let done = false;
    const moovBuf = edit(src, moov.pos, moov.pos + moov.size, (type, box) => {
      if (type !== 'elst' || done) return null;
      done = true;
      const n = box.readUInt32BE(12);
      if (box.readUInt8(8) !== 0) throw new Error('elst is not version 0');
      const out = Buffer.alloc(16 + n * 20);
      out.writeUInt32BE(out.length, 0);
      out.write('elst', 4, 'latin1');
      out.writeUInt8(1, 8);
      out.writeUInt32BE(n, 12);
      let set = false;
      for (let i = 0; i < n; i++) {
        const time = box.readInt32BE(20 + i * 12);
        const media = time !== -1 && !set;
        out.writeBigUInt64BE(media ? BigInt('0x' + holeArg) : BigInt(box.readUInt32BE(16 + i * 12)), 16 + i * 20);
        out.writeBigInt64BE(BigInt(time), 24 + i * 20);
        out.writeInt32BE(box.readInt32BE(24 + i * 12), 32 + i * 20);
        set ||= media;
      }
      if (!set) throw new Error('elst has no media edit');
      return out;
    }, () => null);
    if (!done) throw new Error('no elst');
    final = replaceMoov(src, moovBuf);
  }
  fs.writeFileSync(outFile, final);
  console.log(`${mode}: wrote ${outFile} (${final.length} bytes, was ${src.length})`);
  process.exit(0);
}

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
