export function median(values) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

export function minimum(values) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x));
  return v.length ? Math.min(...v) : null;
}

export function geomean(values) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x) && x > 0);
  return v.length ? Math.exp(v.reduce((s, x) => s + Math.log(x), 0) / v.length) : null;
}

export function primaryTrack(r) {
  if (!r || !Array.isArray(r.videoTracks)) return null;
  return r.videoTracks.find((t) => t.trackId === r.primaryTrackId) ?? r.videoTracks[0] ?? null;
}

const ratio = (q) => (q ? `${q.num}/${q.den}` : null);

export function summarize(r) {
  if (!r) return null;
  const t = primaryTrack(r);
  return {
    container: r.container,
    error: r.error,
    scan: r.scan,
    tracks: r.videoTracks.length,
    avg: ratio(t?.avgFps),
    avgValue: t?.avgFps?.value ?? null,
    frames: t ? (t.presentedFrames ?? t.frames) : null,
    min: ratio(t?.minFps),
    max: ratio(t?.maxFps),
    isVfr: t ? t.isVfr : null,
  };
}

function gcd(a, b) {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a;
}

export function sameRate(a, b) {
  if (!a || !b) return a === b;
  if (Number.isInteger(a.num) && Number.isInteger(a.den) && Number.isInteger(b.num) && Number.isInteger(b.den) && a.den && b.den) {
    const ga = gcd(a.num, a.den) || 1;
    const gb = gcd(b.num, b.den) || 1;
    if (a.num / ga === b.num / gb && a.den / ga === b.den / gb) return true;
  }
  const va = a.value ?? a.num / a.den;
  const vb = b.value ?? b.num / b.den;
  return Math.abs(va / vb - 1) <= 1e-9;
}

export function agreement(own, other) {
  const a = primaryTrack(own);
  const b = primaryTrack(other);
  if (!other) return 'not run';
  if (other.error) return own?.error ? 'both error' : 'error';
  if (!a || !b) return a || b ? 'track differs' : 'no video';
  const avg = sameRate(a.avgFps, b.avgFps);
  const fa = a.presentedFrames ?? a.frames;
  const fb = b.presentedFrames ?? b.frames;
  const frames = fa === fb;
  if (avg && frames) return 'same';
  if (avg) return 'avg same, frames differ';
  if (a.avgFps && b.avgFps) {
    const d = (b.avgFps.value / a.avgFps.value - 1) * 100;
    return `avg ${d > 0 ? '+' : ''}${Math.abs(d) < 0.01 ? d.toExponential(1) : d.toFixed(2)}%${frames ? '' : ', frames differ'}`;
  }
  return 'avg differs';
}

export function withoutTiming(r) {
  if (!r) return r;
  const { io, ...rest } = r;
  return { ...rest, io: io ? { reads: io.reads, bytesRead: io.bytesRead } : io };
}

export function diffPaths(a, b, path = '', out = []) {
  if (out.length >= 20) return out;
  if (Object.is(a, b)) return out;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) {
    out.push(`${path || '.'}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    return out;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) diffPaths(a[k], b[k], Array.isArray(a) ? `${path}[${k}]` : `${path}.${k}`, out);
  return out;
}

export function compareRuns(chrome, node) {
  const diffs = diffPaths(withoutTiming(chrome), withoutTiming(node));
  const a = summarize(chrome);
  const b = summarize(node);
  const keyFields = ['avg', 'frames', 'min', 'max', 'isVfr'].filter((k) => a?.[k] !== b?.[k]);
  return { identical: diffs.length === 0, keyFieldsEqual: keyFields.length === 0, keyFieldDiffs: keyFields, diffs };
}

export function fmtMs(x) {
  if (x === null || x === undefined || !Number.isFinite(x)) return '-';
  if (x < 10) return x.toFixed(2);
  if (x < 100) return x.toFixed(1);
  return Math.round(x).toLocaleString('en-US');
}

export function fmtBytes(n) {
  if (n === null || n === undefined) return '-';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(2)} MiB`;
  return `${(n / 1024 ** 3).toFixed(2)} GiB`;
}

export function fmtPct(part, whole) {
  if (!whole || part === null || part === undefined) return '-';
  const p = (part / whole) * 100;
  if (p === 0) return '0';
  if (p < 0.1) return p.toPrecision(2);
  if (p < 10) return p.toFixed(2);
  return p.toFixed(1);
}

export function fmtFps(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '-';
  return v >= 100 ? v.toFixed(2) : v.toFixed(3);
}
