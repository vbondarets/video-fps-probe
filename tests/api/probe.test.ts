import { openAsBlob } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyze as analyzeCore } from '../../src/core/analyze.ts';
import * as root from '../../src/index.ts';
import { mp4box } from '../../src/plugins/mp4box.ts';
import { FILES_DIR } from '../helpers/fixtures.ts';
import { fakeResult, FakeWorker } from './fake-worker.ts';
import { analyzed, mp4File } from './probe-helpers.ts';

const MP4 = join(FILES_DIR, 'cfr_h264_30.mp4');
const WEBM = join(FILES_DIR, 'cfr_vp9_30.webm');

const entryOf = (w: FakeWorker) => String(w.label).split('/').pop();

beforeEach(() => {
  FakeWorker.reset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('root entry', () => {
  it('exports the probe factory, the in-thread analyze, errors, summary and agreement', () => {
    expect(Object.keys(root).sort()).toEqual(['ProbeError', 'analyze', 'compareResults', 'createProbe', 'isAbortError', 'isTimeoutError', 'summarize']);
  });
});

describe('createProbe', () => {
  it('runs own on the prebuilt own worker', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const probe = root.createProbe();
    expect(probe.engines).toEqual(['own']);
    expect(await probe.analyze(mp4File('a.mp4'))).toEqual(fakeResult('a.mp4'));
    expect(FakeWorker.instances.map(entryOf)).toEqual(['own.worker.ts']);
  });

  it('spawns exactly one worker for an mp4box probe with an own fallback', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    FakeWorker.reset('reply', (m) => (m.type === 'analyze' && m.engine === 'mp4box' ? { type: 'result', result: { ...fakeResult(m.name, 'mp4box'), error: 'bad' } } : undefined));
    const probe = root.createProbe({ engines: [mp4box()], engine: 'mp4box', fallback: ['own'] });
    expect(probe.engines).toEqual(['own', 'mp4box']);
    const result = await probe.analyze(mp4File('a.mp4'));
    expect(result).toMatchObject({ engine: 'own', attempts: [{ engine: 'mp4box', error: 'bad' }] });
    expect(FakeWorker.instances.map(entryOf)).toEqual(['mp4box.worker.ts']);
    expect(analyzed(FakeWorker.instances[0]).map((m) => (m.type === 'analyze' ? m.engine : null))).toEqual(['mp4box', 'own']);
  });

  it('keeps own on the own worker and mp4box on its worker when own is the default', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const probe = root.createProbe({ engines: [mp4box()] });
    await probe.analyze(mp4File());
    await probe.analyze(mp4File(), { engine: 'mp4box' });
    expect(FakeWorker.instances.map(entryOf)).toEqual(['own.worker.ts', 'mp4box.worker.ts']);
  });

  it('analyzes in this thread with worker inline, and without a Worker global, exactly as the core does', async () => {
    const blob = await openAsBlob(MP4);
    const expected = await analyzeCore(blob, 'a.mp4');
    const inline = await root.createProbe({ worker: 'inline' }).analyze(blob, { name: 'a.mp4' });
    expect({ ...inline, io: { ...inline.io, ms: 0 } }).toEqual({ ...expected, io: { ...expected.io, ms: 0 } });
    expect(typeof Worker).toBe('undefined');
    const auto = root.createProbe({ engines: [mp4box()] });
    expect((await auto.analyze(blob, { name: 'a.mp4', engine: 'mp4box' })).engine).toBe('mp4box');
    const webm = await auto.analyze(await openAsBlob(WEBM), { name: 'a.webm', engine: 'mp4box', fallback: ['own'] });
    expect(webm).toMatchObject({ engine: 'own', attempts: [{ engine: 'mp4box', error: 'mp4box does not read this container' }] });
  });

  it('compares own and mp4box in this thread on a real file', async () => {
    const r = await root.createProbe({ engines: [mp4box()], worker: 'inline' }).compare(await openAsBlob(MP4));
    expect(Object.keys(r.outcomes)).toEqual(['own', 'mp4box']);
    expect(r.outcomes.own?.status).toBe('ok');
    expect(r.outcomes.mp4box?.status).toBe('ok');
    expect(r.agreement.fields.find((f) => f.field === 'avgFps')?.agree).toBe(true);
  });
});

describe('root analyze', () => {
  it('runs own in this thread by default and an engine descriptor when given', async () => {
    const blob = await openAsBlob(MP4);
    const own = await root.analyze(blob, { name: 'a.mp4' });
    const expected = await analyzeCore(blob, 'a.mp4');
    expect({ ...own, io: { ...own.io, ms: 0 } }).toEqual({ ...expected, io: { ...expected.io, ms: 0 } });
    expect((await root.analyze(new File([blob], 'named.mp4'))).name).toBe('named.mp4');
    const viaMp4box = await root.analyze(blob, { engine: mp4box(), name: 'b.mp4' });
    expect(viaMp4box).toMatchObject({ engine: 'mp4box', name: 'b.mp4' });
    expect(viaMp4box.mp4box).toBeDefined();
  });
});
