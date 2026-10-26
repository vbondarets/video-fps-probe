import type { ProbeError } from './errors.ts';

const field = (e: unknown, key: 'name' | 'code'): unknown => (typeof e === 'object' && e !== null && key in e ? (e as Record<string, unknown>)[key] : undefined);

export const isProbeError = (e: unknown): e is ProbeError => field(e, 'name') === 'ProbeError' && typeof field(e, 'code') === 'string';

const probeCode = (e: unknown, code: string, otherName: string): boolean => (isProbeError(e) ? e.code === code : field(e, 'name') === otherName);

export function isAbortError(e: unknown): boolean {
  return probeCode(e, 'aborted', 'AbortError');
}

export function isTimeoutError(e: unknown): boolean {
  return probeCode(e, 'timeout', 'TimeoutError');
}
