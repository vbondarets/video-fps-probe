#!/usr/bin/env node
// Byte patcher that turns an ffmpeg-written WebM into MediaRecorder-like variants.
// Usage:
//   node patch-webm.mjs unknown-clusters <in> <out>   set every 8-byte Cluster size to "unknown" (01 FF FF FF FF FF FF FF)
//   node patch-webm.mjs void-defaultduration <in> <out> overwrite the DefaultDuration element with an EBML Void element of equal length
import fs from 'node:fs';

const [mode, inFile, outFile] = process.argv.slice(2);
const buf = Buffer.from(fs.readFileSync(inFile));
let patched = 0;

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
