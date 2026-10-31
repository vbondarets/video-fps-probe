import { analyzeHeader, errorClass, HEADER_DEFAULT_LIMITS, isAbortError, isTimeoutError, warningCodesOf, type HeaderOptions, type HeaderResult } from 'video-fps-probe/header';
import { httpRange, openRangeSource, readCapped, rangeSource, RangeSourceError, type RangeFetcher, type RangeSource } from 'video-fps-probe/url';
import { check, type CheckReport } from 'video-fps-probe/check';
import { klingO1ReferenceVideo, type ProviderPreset } from 'video-fps-probe/presets';

export async function probe(url: string, signal: AbortSignal): Promise<{ result: HeaderResult; report: CheckReport } | string> {
  const options: HeaderOptions = { name: url, signal, limits: { ...HEADER_DEFAULT_LIMITS, maxReads: 3 } };
  try {
    const source: RangeSource = await openRangeSource(httpRange(url), { signal });
    const result = await analyzeHeader(source, options);
    if (result.errorCode) return `${errorClass(result.errorCode)} ${warningCodesOf(result).join(',')}`;
    const preset: ProviderPreset = klingO1ReferenceVideo;
    return { result, report: check(result, preset.rules) };
  } catch (e) {
    if (e instanceof RangeSourceError) return `${e.code} ${e.status ?? ''}`;
    if (isAbortError(e) || isTimeoutError(e)) return 'stopped';
    throw e;
  }
}

export function fromStream(body: AsyncIterable<Uint8Array>, size: number): RangeSource {
  const fetcher: RangeFetcher = async ({ start, end, signal }) => ({ status: 206, contentRange: `bytes ${start}-${end - 1}/${size}`, contentLength: end - start, body: (n) => readCapped(body, n, signal) });
  return rangeSource(fetcher, { size });
}
