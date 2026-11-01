import type { ColorInfo, ContainerLayout, FileResult, VideoTrackResult } from 'video-fps-probe';
import { errorClass, warningCodesOf } from 'video-fps-probe/header';
import { ERROR_TEXT, MD_COMPRESSION } from './codes.ts';
import { bytes, colon } from './format.ts';
import { Cell } from './cells.tsx';

const LAYOUT: Record<ContainerLayout['kind'], string> = { faststart: 'faststart', 'moov-at-end': 'moov at the end', fragmented: 'fragmented' };
const HDR: Record<'pq' | 'hlg', string> = { pq: 'PQ', hlg: 'HLG' };
const PROFILE_TITLE = 'profile_idc for H.264 and HEVC, seq_profile for AV1, the VP9 profile: ffprobe prints a name such as Main 10 instead';
const BITSTREAM_TITLE = 'only the coded frames hold this value, and the package reads the container, not the frames';

function OrBitstream({ value }: { value: string | null }) {
  return value !== null ? <>{value}</> : <span title={BITSTREAM_TITLE}>not in the container <small>bitstream only</small></span>;
}

function hdrText(c: ColorInfo): string {
  const base = c.hdr ? HDR[c.hdr] : null;
  if (c.dolbyVision) return base ? `Dolby Vision, ${base}` : 'Dolby Vision';
  return base ?? 'not signalled';
}

function ColorCells({ c }: { c: ColorInfo | null }) {
  if (c === null) return <Cell k="Color">none declared</Cell>;
  const named = [c.primaries, c.transfer, c.space];
  const dv = c.dolbyVision;
  return (
    <>
      <Cell k="Color" title="primaries, transfer and matrix as ffprobe prints them" extra={`range ${c.range ?? 'unknown'}${c.source ? `, from ${c.source}` : ''}`}>
        {named.some((x) => x !== null) ? named.map((x) => x ?? 'unknown').join(', ') : 'not declared'}
      </Cell>
      <Cell k="HDR">{c.hdr || dv ? <span className="badge hdr">{hdrText(c)}</span> : hdrText(c)}</Cell>
      {dv && (
        <Cell k="Dolby Vision" extra={`compatibility ${dv.compatibilityId}, ${MD_COMPRESSION[dv.mdCompression] ?? dv.mdCompression} metadata compression`}>
          profile {dv.profile}, level {dv.level}
        </Cell>
      )}
      <Cell k="Bit depth" title={c.profile !== null ? PROFILE_TITLE : undefined} extra={c.profile !== null ? `profile number ${c.profile}` : null}>
        <OrBitstream value={c.bitDepth !== null ? `${c.bitDepth}-bit` : null} />
      </Cell>
      <Cell k="Codec string">
        {c.codecString !== null ? <span className="mono">{c.codecString}</span> : <OrBitstream value={null} />}
      </Cell>
    </>
  );
}

function AspectCells({ t }: { t: VideoTrackResult }) {
  const stored = `${t.width}x${t.height}`;
  const shown = t.displayWidth != null && t.displayHeight != null ? `${t.displayWidth}x${t.displayHeight}` : '-';
  return (
    <>
      <Cell k="Aspect ratio" title="sample and display aspect ratio as ffprobe prints them" extra={`DAR ${colon(t.displayAspectRatio)}`}>
        SAR {colon(t.sampleAspectRatio)}
      </Cell>
      <Cell k="Display size" extra={shown !== stored ? `stored ${stored}` : null}>
        {shown}
      </Cell>
    </>
  );
}

function layoutExtra(l: ContainerLayout): string {
  const parts = [l.moovOffset !== null && l.moovSize !== null ? `moov of ${bytes(l.moovSize)} at ${bytes(l.moovOffset)}` : 'no moov seen'];
  if (l.sidx) parts.push('sidx');
  if (l.emptyMoov) parts.push('empty moov');
  return parts.join(', ');
}

export default function Details({ r, t }: { r: FileResult; t: VideoTrackResult | null }) {
  const code = r.errorCode ?? null;
  const warnings = warningCodesOf(r);
  const median = t?.medianFrameInterval;
  return (
    <>
      {code && (
        <p className="code-line">
          <code>{code}</code> <span className="tag">{errorClass(code)}</span> {ERROR_TEXT[code]}
        </p>
      )}
      <dl className="meta">
        {t && t.color !== undefined && <ColorCells c={t.color} />}
        {t && t.sampleAspectRatio !== undefined && <AspectCells t={t} />}
        {median !== undefined && (
          <Cell k="Median frame interval" extra={median ? (t?.timestampsQuantized ? 'on 1 ms timestamps' : `${(1 / median.value).toFixed(3)} fps`) : null}>
            {median ? `${median.num}/${median.den} s` : '-'}
          </Cell>
        )}
        {t?.enabled !== undefined && (
          <Cell k="Enabled" extra={t.enabled ? null : 'players skip this track'}>
            {t.enabled ? 'yes' : 'no'}
          </Cell>
        )}
        {r.layout && (
          <Cell k="Layout" extra={layoutExtra(r.layout)}>
            {LAYOUT[r.layout.kind]}
          </Cell>
        )}
        {warnings.length > 0 && (
          <Cell k="Warning codes">
            <span className="mono">{warnings.join(', ')}</span>
          </Cell>
        )}
      </dl>
    </>
  );
}
