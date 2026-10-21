#!/usr/bin/env node
// Deterministic corruption helpers for negative-test fixtures.
// Usage:
//   node make-corrupt.mjs garbage <out> <bytes> [seed]
//   node make-corrupt.mjs truncate <in> <out> mdat-end|moov-half|ratio:<0..1>
//   node make-corrupt.mjs mdat-size0 <in> <out>          set the (last) mdat 32-bit size to 0 ("extends to EOF")
//   node make-corrupt.mjs stts-count <in> <out> <count>  overwrite the first stts entry_count with a lie
//   node make-corrupt.mjs drop-fragment <in> <out> <n>   remove the n-th (1-based) moof and the mdat right after it
import fs from 'node:fs';

const [mode, a, b, c] = process.argv.slice(2);

function top(buf) {
  const out = [];
  let pos = 0;
  while (pos + 8 <= buf.length) {
    let size = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    if (size === 1) size = Number(buf.readBigUInt64BE(pos + 8));
    else if (size === 0) size = buf.length - pos;
    out.push({ type, pos, size });
    pos += size;
  }
  return out;
}

if (mode === 'garbage') {
  const n = Number(b);
  let x = (Number(c ?? 1) >>> 0) || 1;
  const buf = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    buf[i] = x & 0xff;
  }
  fs.writeFileSync(a, buf);
} else if (mode === 'truncate') {
  const buf = fs.readFileSync(a);
  const t = top(buf);
  const mdat = t.find((x) => x.type === 'mdat');
  const moov = t.find((x) => x.type === 'moov');
  let cut;
  if (c === 'mdat-end') cut = mdat.pos + mdat.size;
  else if (c === 'moov-half') cut = moov.pos + Math.floor(moov.size / 2);
  else if (c.startsWith('ratio:')) cut = Math.floor(buf.length * Number(c.slice(6)));
  fs.writeFileSync(b, buf.subarray(0, cut));
  console.log(`truncate ${c}: ${buf.length} -> ${cut} bytes`);
} else if (mode === 'mdat-size0') {
  const buf = Buffer.from(fs.readFileSync(a));
  const t = top(buf);
  const mdat = t.filter((x) => x.type === 'mdat').pop();
  if (mdat.pos + mdat.size !== buf.length) throw new Error('mdat is not the last box');
  buf.writeUInt32BE(0, mdat.pos);
  fs.writeFileSync(b, buf);
} else if (mode === 'stts-count') {
  const buf = Buffer.from(fs.readFileSync(a));
  const i = buf.indexOf(Buffer.from('stts'));
  buf.writeUInt32BE(Number(c) >>> 0, i + 8);
  fs.writeFileSync(b, buf);
} else if (mode === 'drop-fragment') {
  const buf = fs.readFileSync(a);
  const t = top(buf);
  const moofs = t.filter((x) => x.type === 'moof');
  const moof = moofs[Number(c) - 1];
  const next = moof ? t[t.indexOf(moof) + 1] : null;
  if (!moof || !next || next.type !== 'mdat') throw new Error(`no moof+mdat pair number ${c}`);
  fs.writeFileSync(b, Buffer.concat([buf.subarray(0, moof.pos), buf.subarray(next.pos + next.size)]));
} else {
  console.error('unknown mode');
  process.exit(2);
}
