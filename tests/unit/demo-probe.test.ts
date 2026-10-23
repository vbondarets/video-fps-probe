import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lazyProbeFrom } from '../../src/client/lazy.ts';
import type { WorkerRequest } from '../../src/worker/protocol.ts';
import { fakeResult } from '../api/fake-worker.ts';

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  posted: WorkerRequest[] = [];
  terminated = false;
  readonly url: URL;

  constructor(url: URL) {
    this.url = url;
    FakeWorker.instances.push(this);
  }

  postMessage(message: WorkerRequest): void {
    this.posted.push(message);
    const { v, id } = message;
    if (message.type === 'analyze') {
      const { name, engine } = message;
      queueMicrotask(() => this.onmessage?.({ data: { v, type: 'result', id, result: fakeResult(name, engine) } }));
    } else if (message.type === 'warm') {
      queueMicrotask(() => this.onmessage?.({ data: { v, type: 'warmed', id } }));
    }
  }

  terminate(): void {
    this.terminated = true;
  }
}

const demoProbe = () => lazyProbeFrom(() => import('../../demo/src/ui/probe.ts').then((m) => m.probe));

afterEach(() => {
  vi.unstubAllGlobals();
  FakeWorker.instances = [];
});

describe('demo probe lifecycle for embedding', () => {
  it('prewarm spawns the one demo worker and sends a warm request for the own ISO BMFF parser; dispose terminates idle workers', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    vi.resetModules();
    const probe = demoProbe();
    expect(FakeWorker.instances).toHaveLength(0);
    await probe.prewarm();
    expect(FakeWorker.instances).toHaveLength(1);
    const [worker] = FakeWorker.instances;
    expect(worker.url.pathname).toMatch(/\/ui\/probe\.worker\.ts$/);
    expect(existsSync(fileURLToPath(worker.url))).toBe(true);
    const [request] = worker.posted;
    expect(request).toEqual({ v: 1, type: 'warm', id: request.id, engines: ['own'], containers: ['isobmff'] });
    const result = await probe.analyze(new File([new Uint8Array(8)], 'a.mp4'));
    expect(result.name).toBe('a.mp4');
    expect(worker.posted[1]).toMatchObject({ v: 1, type: 'analyze', name: 'a.mp4', engine: 'own' });
    await probe.analyze(new File([new Uint8Array(8)], 'b.mp4'), { engine: 'mediabunny' });
    expect(worker.posted[2]).toMatchObject({ type: 'analyze', name: 'b.mp4', engine: 'mediabunny' });
    expect(FakeWorker.instances).toHaveLength(1);
    expect(probe.engines).toEqual(['own', 'mp4box', 'mediabunny', 'rvfc']);
    probe.dispose();
    expect(worker.terminated).toBe(true);
    await probe.analyze(new File([new Uint8Array(8)], 'c.mp4'));
    expect(FakeWorker.instances).toHaveLength(2);
  });
});

describe('demo probe chunk loading', () => {
  afterEach(() => {
    vi.doUnmock('../../demo/src/ui/probe.ts');
  });

  it('retries the probe chunk import on the next analysis after a failed fetch', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    vi.resetModules();
    let attempts = 0;
    vi.doMock('../../demo/src/ui/probe.ts', async (importOriginal) => {
      attempts++;
      if (attempts === 1) throw new TypeError('Failed to fetch dynamically imported module');
      return importOriginal();
    });
    const probe = demoProbe();
    await expect(probe.analyze(new File([new Uint8Array(8)], 'a.mp4'))).rejects.toBeInstanceOf(Error);
    expect(FakeWorker.instances).toHaveLength(0);
    const result = await probe.analyze(new File([new Uint8Array(8)], 'b.mp4'));
    expect(result.name).toBe('b.mp4');
    expect(attempts).toBe(2);
    expect(FakeWorker.instances).toHaveLength(1);
  });
});

describe('demo imports', () => {
  it('reach the library only through its package entries', () => {
    const demoSrc = fileURLToPath(new URL('../../demo/src/', import.meta.url));
    const manifest = fileURLToPath(new URL('../../package.json', import.meta.url));
    const files = readdirSync(demoSrc, { recursive: true, encoding: 'utf8' }).filter((f) => /\.tsx?$/.test(f));
    const outside: string[] = [];
    for (const file of files) {
      const text = readFileSync(join(demoSrc, file), 'utf8');
      for (const [, specifier] of text.matchAll(/(?:from\s*|import\s*\(\s*)['"]([^'"]+)['"]/g)) {
        if (!specifier.startsWith('.')) continue;
        const target = resolve(dirname(join(demoSrc, file)), specifier);
        if (relative(demoSrc, target).startsWith('..') && target !== manifest) outside.push(`${file}: ${specifier}`);
      }
    }
    expect(files.length).toBeGreaterThan(5);
    expect(outside).toEqual([]);
  });
});
