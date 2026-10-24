import { win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commandLine, headlessMode, parseBrowserFlags } from '../../scripts/bench/flags.mjs';

describe('bench browser flags', () => {
  it('splits BENCH_BROWSER_FLAGS on any whitespace and keeps the letters', () => {
    expect(parseBrowserFlags('--no-sandbox')).toEqual(['--no-sandbox']);
    expect(parseBrowserFlags('  --no-sandbox \t--disable-gpu\n--use-angle=swiftshader ')).toEqual(['--no-sandbox', '--disable-gpu', '--use-angle=swiftshader']);
    expect(parseBrowserFlags('--disable-features=Spare,Sss')).toEqual(['--disable-features=Spare,Sss']);
    expect(parseBrowserFlags('')).toEqual([]);
    expect(parseBrowserFlags(undefined)).toEqual([]);
  });

  it('names the headless mode from the executable and the extra flags, without the path', () => {
    const shell = win32.join('C:', 'browsers', 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
    expect(headlessMode(shell, ['--no-sandbox'])).toBe('chrome-headless-shell (the old headless mode), extra flags --no-sandbox');
    expect(headlessMode('/opt/chrome/headless_shell')).toBe('headless_shell (the old headless mode)');
    expect(headlessMode('/usr/bin/google-chrome', [])).toBe('headless=new');
    expect(headlessMode(null, ['--a', '--b'])).toBe('headless=new, extra flags --a --b');
  });

  it('records the flags in the command line of a run', () => {
    expect(commandLine('scripts/bench/run-bench.mjs', ['--skip', 'edge'], ['--no-sandbox'])).toBe('BENCH_BROWSER_FLAGS="--no-sandbox" node scripts/bench/run-bench.mjs --skip edge');
    expect(commandLine('scripts/bench/integration.mjs', [], [])).toBe('node scripts/bench/integration.mjs');
  });
});
