import type { CheckRules } from '../check/index.ts';

export type PresetSourceKind = 'official' | 'gateway';

export interface ProviderPreset {
  readonly name: string;
  readonly sourceUrl: string;
  readonly sourceKind: PresetSourceKind;
  readonly verifiedAt: string;
  readonly note: string;
  readonly rules: CheckRules;
}

export const klingO1ReferenceVideo: ProviderPreset = {
  name: 'Kling O1 reference video',
  sourceUrl: 'https://kling.ai/document-api/api/video/o1/video-omni.md',
  sourceKind: 'official',
  verifiedAt: '2026-10-25',
  note: 'The feature or base video of the Kling O1 omni video API, one per request. No codec, aspect ratio or audio rule is published for it.',
  rules: { fps: { min: 24, max: 60 }, duration: { min: 3, max: 10 }, display: { minShortSide: 700, maxLongSide: 2160 }, fileSize: { max: 200_000_000 }, containers: ['mp4', 'mov'] },
};

export const klingMotionControl: ProviderPreset = {
  name: 'Kling Motion Control 3.0 reference video',
  sourceUrl: 'https://kling.ai/document-api/api/video/motion-control.md',
  sourceKind: 'official',
  verifiedAt: '2026-10-25',
  note: 'The 30 s maximum applies when the character orientation follows the video; it is 10 s when it follows the image. No frame rate rule is published.',
  rules: { duration: { min: 3, max: 30 }, display: { minShortSide: 340, maxLongSide: 3850 }, fileSize: { max: 100_000_000 }, containers: ['mp4', 'mov'] },
};

export const runwayAleph2: ProviderPreset = {
  name: 'Runway Aleph 2.0 input video',
  sourceUrl: 'https://docs.dev.runwayml.com/assets/inputs',
  sourceKind: 'official',
  verifiedAt: '2026-10-25',
  note: 'The file size is the ephemeral upload limit; a URL is limited to 32 MB and a data URI to 16 MB. The codecs join what the four containers accept, including the discouraged ones, without pairing codec and container. Aleph keeps the input resolution up to 1080p, and the page does not say whether a larger input is refused, so no size rule.',
  rules: { fps: { max: 30 }, duration: { min: 2, max: 30 }, fileSize: { max: 200_000_000 }, containers: ['mp4', 'mov', 'matroska', 'webm'], codecs: ['h264', 'hevc', 'av1', 'prores', 'vp8', 'vp9', 'mjpeg', 'mpeg2video'] },
};

export const veoExtend: ProviderPreset = {
  name: 'Google Veo 3.1 video to extend',
  sourceUrl: 'https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/video/extend-a-veo-video',
  sourceKind: 'official',
  verifiedAt: '2026-10-25',
  note: 'The frame rate must be 24, so 23.976 fails. The resolution must be 720p, 1080p or 4k; 4k is not given in pixels, so only the 720 px short side is checked. No codec or file size limit is published.',
  rules: { fps: { exact: 24 }, duration: { min: 1, max: 30 }, display: { minShortSide: 720 }, aspectRatio: { oneOf: ['16/9', '9/16'] }, containers: ['mp4'] },
};

export const wan26ReferenceToVideoFal: ProviderPreset = {
  name: 'Wan 2.6 reference to video on fal',
  sourceUrl: 'https://fal.ai/models/wan/v2.6/reference-to-video/api',
  sourceKind: 'official',
  verifiedAt: '2026-10-25',
  note: 'The limits of the fal endpoint, for each of 1 to 3 reference videos. No resolution, aspect ratio or codec limit is published for the input.',
  rules: { fps: { min: 16 }, duration: { min: 2, max: 30 }, fileSize: { max: 30_000_000 }, containers: ['mp4', 'mov'] },
};

export const seedance2ReferenceVideo: ProviderPreset = {
  name: 'Seedance 2.0 reference video',
  sourceUrl: 'https://evolink.ai/docs/en/api-manual/video-series/seedance2.0/seedance-2.0-reference-to-video',
  sourceKind: 'gateway',
  verifiedAt: '2026-10-25',
  note: 'As the EvoLink gateway documents it; no first-party page was verified, and the Runware model page gives only the count. Up to 3 videos of at most 15 s together. The 480p, 720p or 1080p list is checked only through the pixel range.',
  rules: { fps: { min: 24, max: 60 }, duration: { min: 2, max: 15 }, display: { minShortSide: 300, maxLongSide: 6000 }, pixels: { min: 409_600, max: 2_086_876 }, aspectRatio: { min: 0.4, max: 2.5 }, fileSize: { max: 50_000_000 }, containers: ['mp4', 'mov'], severity: 'warn' },
};
