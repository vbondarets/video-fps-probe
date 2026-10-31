import { analyzeHeader, errorClass, type HeaderResult } from 'video-fps-probe/header';
import { rangeSource, RangeSourceError, type RangeFetcher } from 'video-fps-probe/url';
import { withColor, type ColorInfo } from 'video-fps-probe/color';
import { withAspect, type AspectInfo } from 'video-fps-probe/aspect';
import { check, type CheckReport } from 'video-fps-probe/check';
import { klingO1ReferenceVideo } from 'video-fps-probe/presets';

export async function probeObject(fetcher: RangeFetcher, size: number): Promise<{ result: HeaderResult; report: CheckReport; transient: boolean }> {
  const result = await analyzeHeader(rangeSource(fetcher, { size }), { limits: { maxBytes: 2 * 1024 * 1024 } });
  const transient = result.errorCode !== null && result.errorCode !== undefined && errorClass(result.errorCode) !== 'file';
  return { result, report: check(result, klingO1ReferenceVideo.rules), transient };
}

export const isRangeError = (e: unknown): boolean => e instanceof RangeSourceError;

export async function hdrOf(source: Parameters<typeof analyzeHeader>[0]): Promise<{ color: ColorInfo | null | undefined; aspect: Pick<AspectInfo, 'displayWidth' | 'displayHeight'> }> {
  const track = withAspect(withColor(await analyzeHeader(source, { codecConfig: true }), { keepCodecConfig: true })).videoTracks[0];
  return { color: track?.color, aspect: { displayWidth: track?.displayWidth ?? null, displayHeight: track?.displayHeight ?? null } };
}
