import type { FileResult } from 'video-fps-probe';
import { withAspect } from 'video-fps-probe/aspect';
import { withColor } from 'video-fps-probe/color';

export const enrich = <R extends Pick<FileResult, 'videoTracks'>>(result: R): R => withAspect(withColor(result, { keepCodecConfig: true }));
