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
  declare readonly reason?: 'load' | 'crash';

  constructor(code: ProbeErrorCode, message: string, options: ProbeErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : options);
    this.name = 'ProbeError';
    this.code = code;
    this.engine = options.engine ?? null;
  }
}
