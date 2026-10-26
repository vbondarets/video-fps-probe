import { describe, expect, it } from 'vitest';
import { ProbeError } from '../../src/api/errors.ts';
import { isAbortError, isProbeError, isTimeoutError } from '../../src/api/guards.ts';
import { workerFailed } from '../../src/client/pool.ts';

describe('ProbeError', () => {
  it('carries a code, the engine and the cause', () => {
    const cause = new Error('boom');
    const e = new ProbeError('worker-failed', 'worker failed', { engine: 'mp4box', cause });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('ProbeError');
    expect(e.message).toBe('worker failed');
    expect(e.code).toBe('worker-failed');
    expect(e.engine).toBe('mp4box');
    expect(e.cause).toBe(cause);
  });

  it('defaults the engine to null and sets no cause', () => {
    const e = new ProbeError('unsupported-environment', 'no Worker');
    expect(e.engine).toBeNull();
    expect('cause' in e).toBe(false);
  });

  it('sets no reason on a constructed error, and the load or crash reason on a worker failure', () => {
    expect('reason' in new ProbeError('worker-failed', 'worker failed')).toBe(false);
    const cause = new TypeError('Failed to fetch dynamically imported module');
    const load = workerFailed('chunk failed', 'load', 'mp4box', cause);
    expect(load).toBeInstanceOf(ProbeError);
    expect(load).toMatchObject({ name: 'ProbeError', code: 'worker-failed', message: 'chunk failed', engine: 'mp4box', reason: 'load' });
    expect(load.cause).toBe(cause);
    expect(workerFailed('boom', 'crash')).toMatchObject({ code: 'worker-failed', engine: null, reason: 'crash' });
    expect('cause' in workerFailed('boom', 'crash')).toBe(false);
  });
});

describe('abort and timeout guards', () => {
  it('isAbortError accepts ProbeError aborted and an AbortError DOMException', () => {
    expect(isAbortError(new ProbeError('aborted', 'aborted'))).toBe(true);
    expect(isAbortError(new DOMException('Aborted', 'AbortError'))).toBe(true);
    const controller = new AbortController();
    controller.abort();
    expect(isAbortError(controller.signal.reason)).toBe(true);
  });

  it('isAbortError rejects other errors and values', () => {
    expect(isAbortError(new ProbeError('timeout', 'timeout'))).toBe(false);
    expect(isAbortError(new DOMException('Timed out', 'TimeoutError'))).toBe(false);
    expect(isAbortError(new Error('AbortError'))).toBe(false);
    for (const v of [null, undefined, 'AbortError', 42, {}]) expect(isAbortError(v)).toBe(false);
  });

  it('isTimeoutError accepts ProbeError timeout and a TimeoutError DOMException', () => {
    expect(isTimeoutError(new ProbeError('timeout', 'timeout'))).toBe(true);
    expect(isTimeoutError(new DOMException('Timed out', 'TimeoutError'))).toBe(true);
  });

  it('isTimeoutError rejects aborts and other values', () => {
    expect(isTimeoutError(new ProbeError('aborted', 'aborted'))).toBe(false);
    expect(isTimeoutError(new DOMException('Aborted', 'AbortError'))).toBe(false);
    for (const v of [null, undefined, 'TimeoutError', 0]) expect(isTimeoutError(v)).toBe(false);
  });

  it('recognizes a ProbeError by its name and code, so one from another copy of the package counts too', () => {
    const copy = Object.assign(new Error('aborted'), { name: 'ProbeError', code: 'aborted' });
    expect(copy).not.toBeInstanceOf(ProbeError);
    expect(isAbortError(copy)).toBe(true);
    expect(isTimeoutError(copy)).toBe(false);
    expect(isTimeoutError({ name: 'ProbeError', code: 'timeout' })).toBe(true);
    expect(isAbortError({ name: 'ProbeError', code: 'timeout' })).toBe(false);
    expect(isAbortError({ name: 'ProbeError' })).toBe(false);
    expect(isAbortError({ code: 'aborted' })).toBe(false);
  });

  it('isProbeError takes the name and a string code, so the probe never re-wraps an error of another package copy', () => {
    expect(isProbeError(new ProbeError('timeout', 'timed out'))).toBe(true);
    expect(isProbeError(Object.assign(new Error('timed out'), { name: 'ProbeError', code: 'timeout' }))).toBe(true);
    expect(isProbeError({ name: 'ProbeError', code: 'protocol' })).toBe(true);
    for (const v of [{ name: 'ProbeError' }, { name: 'ProbeError', code: 1 }, { code: 'timeout' }, new DOMException('stop', 'AbortError'), new TypeError('ProbeError'), null, undefined, 'ProbeError']) expect(isProbeError(v)).toBe(false);
  });
});
