import { createElement, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { LazyProbe, Probe } from '../../src/client/types.ts';
import type { EngineId } from '../../src/core/types.ts';
import { lazyProbe } from '../../src/lazy.ts';
import { usePrewarmVideoFps, useVideoFps, useVideoFpsProbe, VideoFpsProvider } from '../../src/react/index.ts';

function countingProbe() {
  const counts = { analyze: 0, prewarm: 0 };
  const probe = {
    engines: ['own'],
    analyze: async () => {
      counts.analyze++;
      throw new Error('not reached');
    },
    prewarm: async () => {
      counts.prewarm++;
    },
  } as unknown as Probe<EngineId>;
  return { probe, counts };
}

const render = (probe: Probe<EngineId> | null, child: () => ReactNode): string => {
  const Child = () => child();
  return renderToString(probe ? createElement(VideoFpsProvider, { probe }, createElement(Child)) : createElement(Child));
};

describe('video-fps-probe/react on the server', () => {
  it('throws engine-not-registered from a hook outside VideoFpsProvider', () => {
    expect(() => render(null, () => useVideoFps(null).status)).toThrow(expect.objectContaining({ name: 'ProbeError', code: 'engine-not-registered', message: 'wrap in VideoFpsProvider' }));
  });

  it('renders idle without a file and pending with one, and analyzes nothing during a render', () => {
    const { probe, counts } = countingProbe();
    expect(render(probe, () => useVideoFps(null).status)).toBe('idle');
    expect(render(probe, () => useVideoFps(new Blob([new Uint8Array(4)])).status)).toBe('pending');
    expect(render(probe, () => useVideoFps(new Blob([new Uint8Array(4)]), { enabled: false }).status)).toBe('idle');
    expect(counts.analyze).toBe(0);
  });

  it('gives the probe of the provider, a lazy stub included, and a prewarm callback', async () => {
    const { probe, counts } = countingProbe();
    let prewarm: (() => void) | null = null;
    expect(render(probe, () => String(useVideoFpsProbe() === probe))).toBe('true');
    render(probe, () => ((prewarm = usePrewarmVideoFps({ containers: ['matroska'] })), null));
    prewarm!();
    expect(counts.prewarm).toBe(1);
    const stub: LazyProbe<'own'> = lazyProbe();
    expect(render(stub, () => String(useVideoFpsProbe<LazyProbe<'own'>>().loaded))).toBe('false');
    stub.destroy();
  });
});
