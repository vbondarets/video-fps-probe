import { analyzeHeader, errorClass, type HeaderResult } from 'video-fps-probe/header';
import { rangeSource, RangeSourceError, type RangeFetcher } from 'video-fps-probe/url';
import { check, type CheckReport } from 'video-fps-probe/check';
import { klingO1ReferenceVideo } from 'video-fps-probe/presets';

export async function probeObject(fetcher: RangeFetcher, size: number): Promise<{ result: HeaderResult; report: CheckReport; transient: boolean }> {
  const result = await analyzeHeader(rangeSource(fetcher, { size }), { limits: { maxBytes: 2 * 1024 * 1024 } });
  const transient = result.errorCode !== null && result.errorCode !== undefined && errorClass(result.errorCode) !== 'file';
  return { result, report: check(result, klingO1ReferenceVideo.rules), transient };
}

export const isRangeError = (e: unknown): boolean => e instanceof RangeSourceError;
