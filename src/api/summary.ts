import type { ContainerKind, EngineId, FileResult, Provenance } from '../core/types.ts';

export interface VideoFpsSummary {
  ok: boolean;
  name: string;
  container: ContainerKind;
  engine: EngineId;
  fps: number | null;
  fpsRational: string | null;
  nominalFps: number | null;
  frames: number | null;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  rotation: number | null;
  isVfr: boolean | null;
  minFps: number | null;
  maxFps: number | null;
  approximate: boolean;
  error: string | null;
  warnings: string[];
}

const APPROXIMATE: ReadonlySet<Provenance | undefined> = new Set<Provenance | undefined>(['estimated', 'sampled']);

export function summarize(r: FileResult): VideoFpsSummary {
  const t = r.primaryTrackId === null ? null : (r.videoTracks.find((x) => x.trackId === r.primaryTrackId) ?? null);
  const error = r.error ?? (!t ? 'no video track' : t.avgFps ? null : 'no frame rate');
  return {
    ok: error === null,
    name: r.name,
    container: r.container,
    engine: r.engine,
    fps: t?.avgFps?.value ?? null,
    fpsRational: t?.avgFps ? `${t.avgFps.num}/${t.avgFps.den}` : null,
    nominalFps: t?.nominalFps?.value ?? null,
    frames: t ? (t.presentedFrames ?? t.frames) : null,
    durationSec: t?.durationSec ?? r.formatDurationSec,
    width: t?.width ?? null,
    height: t?.height ?? null,
    rotation: t?.rotation ?? null,
    isVfr: t?.isVfr ?? null,
    minFps: t?.minFps?.value ?? null,
    maxFps: t?.maxFps?.value ?? null,
    approximate: !!t && (['avgFps', 'nominalFps', 'frames'] as const).some((k) => APPROXIMATE.has(t.provenance[k])),
    error,
    warnings: [...r.warnings, ...(t?.warnings ?? [])],
  };
}
