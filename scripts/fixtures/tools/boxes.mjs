#!/usr/bin/env node
// Minimal ISO BMFF structure dumper used to PROVE fixture layout (not the PoC parser).
// Reads only box headers + tiny payloads with fs.readSync (no whole-file read).
// Usage: node boxes.mjs [--tree] file...
import fs from 'node:fs';

const CONT = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'moof', 'traf', 'mvex', 'dinf', 'mfra']);
const args = process.argv.slice(2);
const tree = args.includes('--tree');
const line = args.includes('--line');
const files = args.filter((a) => !a.startsWith('--'));

const io = { reads: 0, bytes: 0 };
function readAt(fd, pos, len) {
  const b = Buffer.alloc(len);
  const n = fs.readSync(fd, b, 0, len, pos);
  io.reads++;
  io.bytes += n;
  return b.subarray(0, n);
}

function u64(b, o) {
  return Number(b.readBigUInt64BE(o));
}

function summarize(file) {
  const fd = fs.openSync(file, 'r');
  const fileSize = fs.fstatSync(fd).size;
  io.reads = 0; io.bytes = 0;
  const res = { file, fileSize, io, top: [], tracks: [], moof: 0, trunSamples: 0, traf: 0, mdat64: false, sidx: 0, errors: [] };
  const lines = [];
  let curTrack = null;

  function walk(start, end, depth, pathStr) {
    let pos = start;
    while (pos + 8 <= end) {
      const h = readAt(fd, pos, 16);
      if (h.length < 8) break;
      let size = h.readUInt32BE(0);
      const type = h.toString('latin1', 4, 8);
      let hdr = 8;
      if (size === 1) {
        if (h.length < 16) { res.errors.push('short largesize at ' + pos); break; }
        size = u64(h, 8);
        hdr = 16;
      } else if (size === 0) {
        size = end - pos;
      }
      let truncated = false;
      if (pos + size > end) { truncated = true; }
      const boxEnd = Math.min(pos + size, end);
      const payloadStart = pos + hdr;
      const info = { type, size, hdr, offset: pos };
      if (truncated) info.truncated = true;
      if (depth === 0) {
        res.top.push(info);
        if (type === 'mdat' && hdr === 16) res.mdat64 = true;
        if (type === 'sidx') res.sidx++;
      }
      let extra = '';
      const avail = boxEnd - payloadStart;
      const rd = (n) => readAt(fd, payloadStart, Math.min(n, avail));
      if (type === 'trak') { curTrack = { handler: null, codec: null, edits: [], stts: null, stco: null, co64: null, ctts: false, stsz: null }; res.tracks.push(curTrack); }
      if (type === 'traf') res.traf++;
      if (type === 'moof') res.moof++;
      if (type === 'mvhd' && avail >= 20) {
        const b = rd(32); const v = b[0];
        res.mvhd = v === 1 ? { timescale: b.readUInt32BE(20), duration: u64(b, 24) } : { timescale: b.readUInt32BE(12), duration: b.readUInt32BE(16) };
      }
      if (type === 'mdhd' && curTrack && avail >= 20) {
        const b = rd(32); const v = b[0];
        curTrack.mdhd = v === 1 ? { timescale: b.readUInt32BE(20), duration: u64(b, 24) } : { timescale: b.readUInt32BE(12), duration: b.readUInt32BE(16) };
        extra = ` ts=${curTrack.mdhd.timescale} dur=${curTrack.mdhd.duration}`;
      }
      if (type === 'tkhd' && curTrack && avail >= 84) {
        const b = rd(100); const v = b[0];
        const off = v === 1 ? 88 : 76;
        curTrack.width = b.readUInt32BE(off) / 65536;
        curTrack.height = b.readUInt32BE(off + 4) / 65536;
        curTrack.trackId = v === 1 ? b.readUInt32BE(20) : b.readUInt32BE(12);
        curTrack.flags = b.readUIntBE(1, 3);
      }
      if (type === 'hdlr' && curTrack && avail >= 12 && pathStr.endsWith('/mdia')) {
        curTrack.handler = rd(12).toString('latin1', 8, 12);
        extra = ' ' + curTrack.handler;
      }
      if (type === 'stsd' && curTrack && avail >= 16) {
        const b = rd(16);
        curTrack.codec = b.toString('latin1', 12, 16);
        curTrack.stsdCount = b.readUInt32BE(4);
        extra = ' ' + curTrack.codec;
      }
      if (type === 'stts' && curTrack && avail >= 8) {
        const b = rd(8 + 8 * 3);
        const n = b.readUInt32BE(4);
        const first = [];
        const have = Math.max(0, Math.floor((b.length - 8) / 8));
        for (let i = 0; i < Math.min(n, 3, have); i++) first.push([b.readUInt32BE(8 + i * 8), b.readUInt32BE(12 + i * 8)]);
        curTrack.stts = { entries: n, first };
        extra = ` entries=${n}`;
      }
      if (type === 'ctts' && curTrack) curTrack.ctts = true;
      if (type === 'stsz' && curTrack && avail >= 12) {
        const b = rd(12);
        curTrack.stsz = { sampleSize: b.readUInt32BE(4), count: b.readUInt32BE(8) };
      }
      if ((type === 'stco' || type === 'co64') && curTrack && avail >= 8) {
        const b = rd(8);
        curTrack[type] = b.readUInt32BE(4);
        extra = ` entries=${b.readUInt32BE(4)}`;
      }
      if (type === 'elst' && curTrack && avail >= 8) {
        const b = rd(8 + 24 * 8); const v = b[0]; const n = b.readUInt32BE(4);
        for (let i = 0; i < Math.min(n, 8); i++) {
          if (v === 1) {
            const o = 8 + i * 20;
            curTrack.edits.push({ segDur: u64(b, o), mediaTime: Number(b.readBigInt64BE(o + 8)), rate: b.readInt16BE(o + 16) });
          } else {
            const o = 8 + i * 12;
            curTrack.edits.push({ segDur: b.readUInt32BE(o), mediaTime: b.readInt32BE(o + 4), rate: b.readInt16BE(o + 8) });
          }
        }
        extra = ` entries=${n} ${JSON.stringify(curTrack.edits)}`;
      }
      if (type === 'trun' && avail >= 8) {
        const b = rd(8);
        res.trunSamples += b.readUInt32BE(4);
      }
      if (type === 'tfhd' && avail >= 8) {
        const b = rd(8);
        const fl = b.readUIntBE(1, 3);
        res.tfhdFlags = (res.tfhdFlags || new Set());
        res.tfhdFlags.add('0x' + fl.toString(16));
      }
      if (tree) lines.push(`${'  '.repeat(depth)}${type} size=${size} hdr=${hdr} @${pos}${truncated ? ' TRUNCATED' : ''}${extra}`);
      if (CONT.has(type)) {
        walk(payloadStart, boxEnd, depth + 1, pathStr + '/' + type);
      } else if (type === 'meta' && avail > 4) {
        walk(payloadStart + 4, boxEnd, depth + 1, pathStr + '/' + type);
      }
      if (size < hdr) { res.errors.push('bad size at ' + pos); break; }
      pos += size;
    }
  }

  try {
    walk(0, fileSize, 0, '');
  } catch (e) {
    res.errors.push(String(e));
  }
  fs.closeSync(fd);
  if (res.tfhdFlags) res.tfhdFlags = [...res.tfhdFlags];
  res.layout = res.top.map((t) => t.type).join(' ');
  const rle = [];
  for (const t of res.top) {
    const l = rle[rle.length - 1];
    if (l && l[0] === t.type) l[1]++;
    else rle.push([t.type, 1]);
  }
  res.layoutRle = rle.map(([t, n]) => (n > 1 ? t + 'x' + n : t)).join(' ');
  if (tree) console.log(lines.join('\n'));
  return res;
}

for (const f of files) {
  const r = summarize(f);
  if (line) {
    const t = r.tracks.find((x) => x.handler === "vide") ?? r.tracks[0] ?? {};
    console.log([f.split("/").pop(), r.fileSize, r.layoutRle, "mdat64=" + r.mdat64, "moof=" + r.moof, "trunSamples=" + r.trunSamples, "tracks=" + r.tracks.length, "ts=" + t.mdhd?.timescale, "stts=" + JSON.stringify(t.stts), "edits=" + JSON.stringify(t.edits), "ctts=" + t.ctts, "stco=" + t.stco, "co64=" + t.co64, "io=" + r.io.reads + "reads/" + r.io.bytes + "B", r.errors.length ? "ERR=" + r.errors.join(";") : ""].join(" | "));
  } else if (!tree) {
    const compact = {
      file: f, fileSize: r.fileSize, layout: r.layoutRle, layoutRaw: r.layout, truncated: r.top.filter((t) => t.truncated).map((t) => t.type), io: r.io, mdat64: r.mdat64, moof: r.moof, traf: r.traf, trunSamples: r.trunSamples,
      tfhdFlags: r.tfhdFlags, mvhd: r.mvhd,
      tracks: r.tracks.map((t) => ({ id: t.trackId, handler: t.handler, codec: t.codec, ts: t.mdhd?.timescale, mdhdDur: t.mdhd?.duration, w: t.width, h: t.height, stts: t.stts, edits: t.edits, ctts: t.ctts, stco: t.stco, co64: t.co64, stsz: t.stsz })),
      errors: r.errors,
    };
    console.log(JSON.stringify(compact));
  }
}
