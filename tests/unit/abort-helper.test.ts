import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { throwIfAborted } from '../../src/core/abort.ts';

const SRC = join(import.meta.dirname, '..', '..', 'src');

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []));

describe('abort helper', () => {
  it('does nothing without a signal or before the abort', () => {
    expect(() => throwIfAborted(null)).not.toThrow();
    expect(() => throwIfAborted(undefined)).not.toThrow();
    expect(() => throwIfAborted(new AbortController().signal)).not.toThrow();
  });

  it('throws the abort reason when the signal has one', () => {
    const controller = new AbortController();
    const reason = new Error('stop');
    controller.abort(reason);
    expect(() => throwIfAborted(controller.signal)).toThrow(reason);
  });

  it('throws an AbortError DOMException for a signal without reason (Chrome 94-97)', () => {
    const legacy = { aborted: true } as AbortSignal;
    let caught: unknown;
    try {
      throwIfAborted(legacy);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DOMException);
    expect((caught as DOMException).name).toBe('AbortError');
  });

  it('is the only abort check in src: AbortSignal.throwIfAborted needs Chrome and Edge 100', () => {
    const offenders = sources(SRC).filter((f) => /\.throwIfAborted\s*\(/.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => relative(SRC, f))).toEqual([]);
  });
});
