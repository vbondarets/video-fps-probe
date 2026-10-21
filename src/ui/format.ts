import type { Provenance, Rational } from '../core/types.ts';

export const PROVENANCE: Record<Provenance, readonly [string, string]> = {
  header: ['H', 'header: read from the container headers'],
  exact: ['E', 'exact: computed from every sample or block timestamp'],
  sampled: ['S', 'sampled: measured on a sample of blocks, never used for an average'],
  estimated: ['~', 'estimated: derived by assuming a constant frame rate'],
  computed: ['C', 'computed: ffprobe prints N/A here, the app computes it'],
};

export const fps = (r: Rational | null | undefined): string => (r ? r.value.toFixed(3) : '-');

export const count = (n: number | null | undefined): string => (n === null || n === undefined ? '-' : n.toLocaleString('en-US'));

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`;
}

export function ms(n: number): string {
  return n < 10 ? `${n.toFixed(2)} ms` : n < 1000 ? `${n.toFixed(0)} ms` : `${(n / 1000).toFixed(2)} s`;
}

export function duration(s: number | null | undefined): string {
  if (s === null || s === undefined) return '-';
  if (s < 60) return `${s.toFixed(3)} s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h > 0 ? `${h}:${String(m).padStart(2, '0')}` : m}:${(s % 60).toFixed(3).padStart(6, '0')}`;
}

export function share(x: number): string {
  if (x > 0 && x < 0.001) return '<0.1%';
  return `${(x * 100).toFixed(x > 0 && x < 0.1 ? 1 : 0)}%`;
}

export function readPercent(read: number, size: number): string {
  const p = size > 0 ? (read / size) * 100 : 0;
  return p === 0 ? '0%' : p < 0.01 ? '<0.01%' : `${p.toFixed(p < 10 ? 2 : 1)}%`;
}

export const rate = (x: number): string => String(+x.toPrecision(4));

export function clock(sec: number): string {
  const t = Math.round(sec * 10) / 10;
  const s = +(t % 60).toFixed(1);
  const m = Math.floor(t / 60);
  return `${m < 60 ? m : `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`}:${s < 10 ? '0' : ''}${s}`;
}
