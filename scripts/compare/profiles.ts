export interface ProfileEntry {
  codec: string;
  profile: number;
  constraintMask: number;
  constraintValue: number;
  name: string;
}

const H264_SET1 = 0x40;
const H264_SET3 = 0x10;

const entry = (codec: string, profile: number, name: string, constraintMask = 0, constraintValue = 0): ProfileEntry => ({ codec, profile, constraintMask, constraintValue, name });

export const PROFILE_TABLE: readonly ProfileEntry[] = [
  entry('h264', 66, 'Constrained Baseline', H264_SET1, H264_SET1),
  entry('h264', 66, 'Baseline'),
  entry('h264', 77, 'Main'),
  entry('h264', 88, 'Extended'),
  entry('h264', 100, 'High'),
  entry('h264', 110, 'High 10 Intra', H264_SET3, H264_SET3),
  entry('h264', 110, 'High 10'),
  entry('h264', 122, 'High 4:2:2 Intra', H264_SET3, H264_SET3),
  entry('h264', 122, 'High 4:2:2'),
  entry('h264', 144, 'High 4:4:4'),
  entry('h264', 244, 'High 4:4:4 Intra', H264_SET3, H264_SET3),
  entry('h264', 244, 'High 4:4:4 Predictive'),
  entry('h264', 44, 'CAVLC 4:4:4'),
  entry('h264', 118, 'Multiview High'),
  entry('h264', 128, 'Stereo High'),
  entry('hevc', 1, 'Main'),
  entry('hevc', 2, 'Main 10'),
  entry('hevc', 3, 'Main Still Picture'),
  entry('hevc', 4, 'Rext'),
  entry('hevc', 6, 'Multiview Main'),
  entry('hevc', 9, 'SCC'),
  entry('av1', 0, 'Main'),
  entry('av1', 1, 'High'),
  entry('av1', 2, 'Professional'),
  entry('vp9', 0, 'Profile 0'),
  entry('vp9', 1, 'Profile 1'),
  entry('vp9', 2, 'Profile 2'),
  entry('vp9', 3, 'Profile 3'),
];

export const PROFILE_NOT_READ: Readonly<Record<string, string>> = {
  mjpeg: 'JPEG carries its profile in the frame header, not in a codec configuration',
  png: 'PNG has no profile',
  prores: 'ProRes names its profile by the sample entry fourcc, not in a codec configuration the library reads',
  vp8: 'VP8 carries its version in the frame header, not in a codec configuration',
};

export function ffmpegProfileName(codec: string, profile: number, constraints: number | null): string | null {
  for (const e of PROFILE_TABLE) {
    if (e.codec !== codec || e.profile !== profile) continue;
    if (e.constraintMask === 0 || ((constraints ?? 0) & e.constraintMask) === e.constraintValue) return e.name;
  }
  return null;
}

export function profileNamesOf(codec: string): string[] {
  return PROFILE_TABLE.filter((e) => e.codec === codec).map((e) => e.name);
}

export function constraintsFromCodecString(codecString: string | null | undefined): number | null {
  const m = /^avc[13]\.[0-9a-f]{2}([0-9a-f]{2})[0-9a-f]{2}$/i.exec(codecString ?? '');
  return m ? parseInt(m[1], 16) : null;
}
