import { describe, expect, it } from 'vitest';
import { parseBrowserFlags } from '../../scripts/bench/flags.mjs';

describe('bench browser flags', () => {
  it('splits BENCH_BROWSER_FLAGS on any whitespace and keeps the letters', () => {
    expect(parseBrowserFlags('--no-sandbox')).toEqual(['--no-sandbox']);
    expect(parseBrowserFlags('  --no-sandbox \t--disable-gpu\n--use-angle=swiftshader ')).toEqual(['--no-sandbox', '--disable-gpu', '--use-angle=swiftshader']);
    expect(parseBrowserFlags('--disable-features=Spare,Sss')).toEqual(['--disable-features=Spare,Sss']);
    expect(parseBrowserFlags('')).toEqual([]);
    expect(parseBrowserFlags(undefined)).toEqual([]);
  });
});
