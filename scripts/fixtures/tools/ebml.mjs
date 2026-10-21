#!/usr/bin/env node
// Minimal EBML (WebM/Matroska) structure dumper used to PROVE fixture layout (not the PoC parser).
// Usage: node ebml.mjs [--line] file...
import fs from 'node:fs';

const ID = {
  EBML: 0x1a45dfa3, Segment: 0x18538067, SeekHead: 0x114d9b74, Info: 0x1549a966, Tracks: 0x1654ae6b,
  Cluster: 0x1f43b675, Cues: 0x1c53bb6b, Tags: 0x1254c367, Chapters: 0x1043a770, Attachments: 0x1941a469, Void: 0xec,
  TimecodeScale: 0x2ad7b1, Duration: 0x4489, TrackEntry: 0xae, TrackNumber: 0xd7, TrackType: 0x83, CodecID: 0x86,
  DefaultDuration: 0x23e383, Video: 0xe0, PixelWidth: 0xb0, PixelHeight: 0xba, Timecode: 0xe7, SimpleBlock: 0xa3,
  BlockGroup: 0xa0, Block: 0xa1, BlockDuration: 0x9b, DocType: 0x4282,
};
const SEG_LEVEL = new Set([ID.Cluster, ID.Cues, ID.Tags, ID.SeekHead, ID.Info, ID.Tracks, ID.Chapters, ID.Attachments]);

const args = process.argv.slice(2);
const line = args.includes('--line');
const dumpBlocks = args.includes('--blocks');
const files = args.filter((a) => !a.startsWith('--'));

function summarize(file) {
  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size;
  const res = { file, size, docType: null, segment: null, timecodeScale: 1e6, duration: null, tracks: [], clusters: 0, simpleBlocks: 0, blockGroups: 0, unknownSizeClusters: 0, cues: 0, blocks: [] };
  const buf = Buffer.alloc(64);
  function rd(pos, n) {
    const got = fs.readSync(fd, buf, 0, n, pos);
    return got;
  }
  function readId(pos) {
    if (rd(pos, 4) < 1) return null;
    const b0 = buf[0];
    let len = 1;
    while (len <= 4 && !(b0 & (0x80 >> (len - 1)))) len++;
    if (len > 4) return null;
    let id = 0;
    for (let i = 0; i < len; i++) id = id * 256 + buf[i];
    return { id, len };
  }
  function readSize(pos) {
    rd(pos, 8);
    const b0 = buf[0];
    let len = 1;
    while (len <= 8 && !(b0 & (0x80 >> (len - 1)))) len++;
    if (len > 8) return null;
    let v = BigInt(b0 & (0xff >> len));
    let allOnes = (b0 & (0xff >> len)) === (0xff >> len);
    for (let i = 1; i < len; i++) {
      v = (v << 8n) | BigInt(buf[i]);
      if (buf[i] !== 0xff) allOnes = false;
    }
    return { size: allOnes ? -1 : Number(v), len };
  }
  function readUInt(pos, n) {
    rd(pos, n);
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 256 + buf[i];
    return v;
  }
  function readFloat(pos, n) {
    rd(pos, n);
    return n === 4 ? buf.readFloatBE(0) : buf.readDoubleBE(0);
  }
  function readStr(pos, n) {
    rd(pos, Math.min(n, 60));
    return buf.toString('latin1', 0, Math.min(n, 60));
  }

  function* children(start, end, stopAtSegLevel) {
    let pos = start;
    while (pos < end) {
      const idr = readId(pos);
      if (!idr) return;
      if (stopAtSegLevel && SEG_LEVEL.has(idr.id)) return;
      const sz = readSize(pos + idr.len);
      if (!sz) return;
      const dataStart = pos + idr.len + sz.len;
      const dataEnd = sz.size < 0 ? end : Math.min(dataStart + sz.size, end);
      yield { id: idr.id, dataStart, dataEnd, unknown: sz.size < 0, headerLen: idr.len + sz.len, size: sz.size, pos };
      pos = dataEnd;
    }
  }

  function parseCluster(el) {
    res.clusters++;
    if (el.unknown) res.unknownSizeClusters++;
    let clusterTs = 0;
    const addBlock = (dataStart) => {
      const tn = readSize(dataStart);
      const rel = (() => { rd(dataStart + tn.len, 3); return buf.readInt16BE(0); })();
      res.blocks.push({ track: tn.size, ts: clusterTs + rel });
    };
    for (const c of children(el.dataStart, el.dataEnd, el.unknown)) {
      if (c.id === ID.Timecode) clusterTs = readUInt(c.dataStart, c.dataEnd - c.dataStart);
      else if (c.id === ID.SimpleBlock) { res.simpleBlocks++; addBlock(c.dataStart); }
      else if (c.id === ID.BlockGroup) {
        res.blockGroups++;
        for (const g of children(c.dataStart, c.dataEnd, false)) if (g.id === ID.Block) addBlock(g.dataStart);
      }
      el.realEnd = c.dataEnd;
    }
    return el.unknown ? (el.realEnd ?? el.dataStart) : el.dataEnd;
  }

  const top = [...children(0, size, false)];
  for (const el of top) {
    if (el.id === ID.EBML) {
      for (const c of children(el.dataStart, el.dataEnd, false)) if (c.id === ID.DocType) res.docType = readStr(c.dataStart, c.dataEnd - c.dataStart);
    } else if (el.id === ID.Segment) {
      res.segment = { unknownSize: el.unknown, declaredSize: el.size, headerLen: el.headerLen };
      const segEnd = el.unknown ? size : el.dataEnd;
      let pos = el.dataStart;
      while (pos < segEnd) {
        const idr = readId(pos);
        if (!idr) break;
        const sz = readSize(pos + idr.len);
        if (!sz) break;
        const dataStart = pos + idr.len + sz.len;
        const e = { id: idr.id, dataStart, dataEnd: sz.size < 0 ? segEnd : Math.min(dataStart + sz.size, segEnd), unknown: sz.size < 0, size: sz.size };
        if (e.id === ID.Info) {
          for (const c of children(e.dataStart, e.dataEnd, false)) {
            if (c.id === ID.TimecodeScale) res.timecodeScale = readUInt(c.dataStart, c.dataEnd - c.dataStart);
            else if (c.id === ID.Duration) res.duration = readFloat(c.dataStart, c.dataEnd - c.dataStart);
          }
        } else if (e.id === ID.Tracks) {
          for (const te of children(e.dataStart, e.dataEnd, false)) {
            if (te.id !== ID.TrackEntry) continue;
            const t = {};
            for (const c of children(te.dataStart, te.dataEnd, false)) {
              if (c.id === ID.TrackNumber) t.number = readUInt(c.dataStart, c.dataEnd - c.dataStart);
              else if (c.id === ID.TrackType) t.type = readUInt(c.dataStart, c.dataEnd - c.dataStart);
              else if (c.id === ID.CodecID) t.codec = readStr(c.dataStart, c.dataEnd - c.dataStart);
              else if (c.id === ID.DefaultDuration) t.defaultDurationNs = readUInt(c.dataStart, c.dataEnd - c.dataStart);
              else if (c.id === ID.Video) {
                for (const v of children(c.dataStart, c.dataEnd, false)) {
                  if (v.id === ID.PixelWidth) t.w = readUInt(v.dataStart, v.dataEnd - v.dataStart);
                  if (v.id === ID.PixelHeight) t.h = readUInt(v.dataStart, v.dataEnd - v.dataStart);
                }
              }
            }
            res.tracks.push(t);
          }
        } else if (e.id === ID.Cluster) {
          const end = parseCluster(e);
          pos = e.unknown ? end : e.dataEnd;
          continue;
        } else if (e.id === ID.Cues) {
          res.cues++;
        }
        pos = e.dataEnd;
      }
    }
  }
  fs.closeSync(fd);
  return res;
}

for (const f of files) {
  const r = summarize(f);
  const vt = r.tracks.find((t) => t.type === 1);
  const vblocks = r.blocks.filter((b) => !vt || b.track === vt.number).map((b) => b.ts).sort((a, b) => a - b);
  let minD = null;
  let maxD = null;
  for (let i = 1; i < vblocks.length; i++) {
    const d = vblocks[i] - vblocks[i - 1];
    if (minD === null || d < minD) minD = d;
    if (maxD === null || d > maxD) maxD = d;
  }
  const tsMs = r.timecodeScale / 1e6;
  const summary = {
    file: f.split('/').pop(), size: r.size, docType: r.docType, segUnknownSize: r.segment?.unknownSize, timecodeScaleNs: r.timecodeScale,
    durationTicks: r.duration, durationSec: r.duration == null ? null : (r.duration * r.timecodeScale) / 1e9,
    tracks: r.tracks.map((t) => ({ ...t, defaultDurationFps: t.defaultDurationNs ? 1e9 / t.defaultDurationNs : undefined })),
    clusters: r.clusters, unknownSizeClusters: r.unknownSizeClusters, simpleBlocks: r.simpleBlocks, blockGroups: r.blockGroups, cues: r.cues,
    videoBlocks: vblocks.length, blockDeltaMinTicks: minD, blockDeltaMaxTicks: maxD,
    blockMinFps: maxD ? 1000 / (maxD * tsMs) : null, blockMaxFps: minD ? 1000 / (minD * tsMs) : null,
  };
  if (line) {
    console.log([summary.file, summary.size, summary.docType, `segUnknown=${summary.segUnknownSize}`, `tcs=${summary.timecodeScaleNs}`, `dur=${summary.durationSec?.toFixed(3) ?? 'none'}`,
      'tracks=' + summary.tracks.map((t) => `${t.codec}${t.defaultDurationNs ? '(DefaultDuration=' + t.defaultDurationNs + 'ns)' : '(no DefaultDuration)'}`).join(','),
      `clusters=${summary.clusters}(unknown=${summary.unknownSizeClusters})`, `blocks=${summary.simpleBlocks}SB+${summary.blockGroups}BG`, `cues=${summary.cues}`,
      `blockDelta=${minD}..${maxD}ticks`].join(' | '));
  } else {
    console.log(JSON.stringify(summary));
  }
  if (dumpBlocks) console.log(vblocks.join(','));
}
