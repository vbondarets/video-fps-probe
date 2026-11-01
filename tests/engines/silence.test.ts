import { openAsBlob, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withAspect } from '../../src/aspect/index.ts';
import { withColor } from '../../src/color/index.ts';
import { analyze } from '../../src/core/analyze.ts';
import type { FileResult } from '../../src/core/types.ts';
import { analyzeWithMediabunny } from '../../src/engines/mediabunny.ts';
import { analyzeWithMp4box } from '../../src/engines/mp4box.ts';
import { analyzeHeader } from '../../src/header/index.ts';
import { FILES_DIR } from '../helpers/fixtures.ts';

type Run = (blob: Blob, name: string) => Promise<FileResult>;

const FILES = readdirSync(FILES_DIR).sort();
const CONSOLE_METHODS = Object.keys(console).filter((key) => typeof (console as unknown as Record<string, unknown>)[key] === 'function');

const RUNS: ReadonlyArray<readonly [label: string, run: Run]> = [
  ['own probe', (blob, name) => analyze(blob, name, { matroskaMode: 'probe' })],
  ['own exact with color and aspect', async (blob, name) => withAspect(withColor(await analyze(blob, name, { matroskaMode: 'exact', codecConfig: true }), { keepCodecConfig: true }))],
  ['mediabunny', analyzeWithMediabunny],
  ['analyzeHeader with codecConfig, color and aspect', (blob, name) => analyzeHeader(blob, { name, codecConfig: true, color: true, aspect: true })],
];

const warningsOf = (r: FileResult): string[] => [...r.warnings, ...r.videoTracks.flatMap((t) => t.warnings)];

describe('the engines write nothing to the console and emit no process warning', () => {
  const calls: string[] = [];
  const onWarning = (warning: Error) => calls.push(`warning event ${warning.name}: ${warning.message}`);

  beforeEach(() => {
    calls.length = 0;
    for (const method of CONSOLE_METHODS) {
      vi.spyOn(console as unknown as Record<string, (...args: unknown[]) => void>, method).mockImplementation((...args: unknown[]) => {
        calls.push(`console.${method}(${args.map((a) => inspect(a)).join(', ')})`);
      });
    }
    const emitWarning = process.emitWarning.bind(process);
    vi.spyOn(process, 'emitWarning').mockImplementation(((warning: string | Error, ...rest: unknown[]) => {
      calls.push(`process.emitWarning(${inspect(warning)})`);
      return (emitWarning as (...args: unknown[]) => void)(warning, ...rest);
    }) as typeof process.emitWarning);
    process.on('warning', onWarning);
  });

  afterEach(() => {
    process.off('warning', onWarning);
    vi.restoreAllMocks();
  });

  it('spies on every console method', () => {
    expect(CONSOLE_METHODS).toEqual(expect.arrayContaining(['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'table', 'assert', 'count', 'group', 'time', 'timeEnd']));
  });

  const everyFixture = async (run: Run): Promise<FileResult[]> => {
    const results: FileResult[] = [];
    for (const name of FILES) results.push(await run(await openAsBlob(join(FILES_DIR, name)), name));
    await new Promise((done) => setImmediate(done));
    return results;
  };

  it.each(RUNS)('%s over every committed fixture', async (_label, run) => {
    expect(await everyFixture(run)).toHaveLength(FILES.length);
    expect(calls).toEqual([]);
  });

  it('mp4box over every committed fixture, while its log hook captures what mp4box logs', async () => {
    const results = await everyFixture(analyzeWithMp4box);
    expect(calls).toEqual([]);
    expect(results.flatMap(warningsOf).filter((w) => w.startsWith('mp4box log: ')).length, 'mp4box log warnings').toBeGreaterThan(0);
  });
});
