export const SAMPLES = [
  'cfr_h264_29.97.mp4',
  'vfr_concat_10_30_60.mp4',
  'fmp4_frag_duration.mp4',
  'mov_bf_elst.mov',
  'cfr_vp9_59.94.webm',
  'h264_vfr_remux.mkv',
  'hdr10_hevc10.mp4',
  'dv_p81_dvvc.mp4',
  'sar_h264_4x3.mp4',
  'track_disabled.mp4',
] as const;

export const sampleUrl = (name: string): string => new URL(`${import.meta.env.BASE_URL}samples/${name}`, location.href).href;

export function loadSamples(): Promise<File[]> {
  return Promise.all(
    SAMPLES.map(async (name) => {
      const res = await fetch(sampleUrl(name));
      if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
      const blob = await res.blob();
      return new File([blob], name, { type: blob.type });
    }),
  );
}
