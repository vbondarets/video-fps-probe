import type { EngineId } from '../core/types.ts';

export type ProbeErrorCode =
  | 'aborted'
  | 'timeout'
  | 'worker-failed'
  | 'engine-not-registered'
  | 'unknown-engine'
  | 'unsupported-environment'
  | 'protocol';

export interface ProbeErrorOptions {
  engine?: EngineId | null;
  cause?: unknown;
}

export class ProbeError extends Error {
  readonly code: ProbeErrorCode;
  readonly engine: EngineId | null;

  constructor(code: ProbeErrorCode, message: string, options: ProbeErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProbeError';
    this.code = code;
    this.engine = options.engine ?? null;
  }
}

const nameOf = (e: unknown): unknown => (typeof e === 'object' && e !== null && 'name' in e ? (e as { name: unknown }).name : undefined);

export function isAbortError(e: unknown): boolean {
  return e instanceof ProbeError ? e.code === 'aborted' : nameOf(e) === 'AbortError';
}

export function isTimeoutError(e: unknown): boolean {
  return e instanceof ProbeError ? e.code === 'timeout' : nameOf(e) === 'TimeoutError';
}
