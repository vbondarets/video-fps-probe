import type { CodecConfig } from '../types.ts';
import { childBoxes, readBoxHeader, type BoxHeader } from './boxes.ts';
import type { IsoMovie, IsoTrack } from './model.ts';

const MAX_BOX_COPY = 65536;

function copy(dv: DataView, h: BoxHeader | undefined): Uint8Array | null {
  return h ? new Uint8Array(dv.buffer, dv.byteOffset + h.start, Math.min(h.end - h.start, MAX_BOX_COPY)).slice() : null;
}

function child(dv: DataView, parent: BoxHeader, type: string): BoxHeader | undefined {
  let last: BoxHeader | undefined;
  for (const c of childBoxes(dv, parent.start + parent.headerSize, parent.end)) if (c.type === type) last = c;
  return last;
}

export function isoCodecConfig(movie: IsoMovie, track: IsoTrack): CodecConfig {
  const config: CodecConfig = { family: 'isobmff', stsd: null, tkhd: null, mvhd: null };
  const dv = track.dv ?? movie.tracks.find((t) => t.dv)?.dv;
  const moov = dv ? readBoxHeader(dv, 0, dv.byteLength) : null;
  if (!dv || !moov || moov.type !== 'moov') return config;
  const index = movie.tracks.indexOf(track);
  let n = 0;
  for (const c of childBoxes(dv, moov.headerSize, moov.end)) {
    if (c.type === 'mvhd') config.mvhd = copy(dv, c);
    else if (c.type === 'trak' && n++ === index) {
      config.tkhd = copy(dv, child(dv, c, 'tkhd'));
      const mdia = child(dv, c, 'mdia');
      const minf = mdia && child(dv, mdia, 'minf');
      const stbl = minf && child(dv, minf, 'stbl');
      config.stsd = copy(dv, stbl && child(dv, stbl, 'stsd'));
    }
  }
  return config;
}
