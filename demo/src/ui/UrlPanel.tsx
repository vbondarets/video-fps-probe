import { useEffect, useRef, useState, type FormEvent } from 'react';
import { analyzeHeader, isAbortError } from 'video-fps-probe/header';
import { httpRange, openRangeSource, RangeSourceError } from 'video-fps-probe/url';
import { setExtra } from './extras.ts';
import { enrich } from './meta.ts';
import { sampleUrl, SAMPLES } from './samples.ts';
import Snippet from './Snippet.tsx';
import { urlSnippet, type UrlMode } from './snippets.ts';
import { useStore } from './store.ts';
import SubCard, { type PlannedResult } from './SubCard.tsx';

interface UrlRun {
  id: number;
  url: string;
  mode: UrlMode;
  requests: number;
  result: PlannedResult | null;
  error: string | null;
}

const DEFAULT_SAMPLE = 'hdr10_hevc10.mp4';
const MODE_LABEL: Record<UrlMode, string> = { header: 'header only (analyzeHeader)', full: 'full (analyze, in this thread)' };

function nameOf(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() || url);
  } catch {
    return url;
  }
}

function describe(e: unknown): string {
  if (e instanceof RangeSourceError) return `${e.code}${e.status !== null ? ` (HTTP ${e.status})` : ''}: ${e.message}`;
  if (e instanceof TypeError) return `${e.message}. The server may be unreachable, or it does not allow this page to read it (CORS).`;
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

let nextRun = 1;

export default function UrlPanel() {
  const { mode: matroskaMode } = useStore();
  const [url, setUrl] = useState(() => sampleUrl(DEFAULT_SAMPLE));
  const [mode, setMode] = useState<UrlMode>('header');
  const [runs, setRuns] = useState<UrlRun[]>([]);
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);

  useEffect(() => {
    const results = runs.flatMap((r) => (r.result ? [{ url: r.url, mode: r.mode, httpRequests: r.requests, result: r.result }] : []));
    setExtra('url', results.length > 0 ? { results } : undefined);
  }, [runs]);

  useEffect(() => () => active.current?.abort(), []);

  const analyze = async (e: FormEvent) => {
    e.preventDefault();
    active.current?.abort();
    const controller = (active.current = new AbortController());
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
    const run: UrlRun = { id: nextRun++, url, mode, requests: 0, result: null, error: null };
    const counted: typeof fetch = (input, init) => {
      run.requests++;
      return fetch(input, init);
    };
    setBusy(true);
    try {
      const source = await openRangeSource(httpRange(url, { fetch: counted }), { signal });
      const name = nameOf(url);
      if (mode === 'header') run.result = await analyzeHeader(source, { name, signal, color: true, aspect: true });
      else {
        const { ownEngine } = await import('video-fps-probe/worker-runtime');
        run.result = enrich(await ownEngine.run(source, name, { matroskaMode, codecConfig: true, signal }));
      }
    } catch (err) {
      if (controller.signal.aborted && isAbortError(err)) return;
      run.error = describe(err);
    } finally {
      if (active.current === controller) {
        active.current = null;
        setBusy(false);
      }
    }
    setRuns((prev) => [run, ...prev]);
  };

  return (
    <div className="panel-body">
      <p className="intro">
        <code>video-fps-probe/url</code> reads a file over HTTP with Range requests. <code>httpRange</code> wraps <code>fetch</code>,{' '}
        <code>openRangeSource</code> learns the size from the first ranged reply, and the analysis asks only for the bytes it needs, so a
        server can check a file in object storage without downloading it. The samples below are served by this page, so they work as they are.
      </p>
      <p className="note small">
        Another host works only when its server allows it. The browser lets this page read another site when that server sends{' '}
        <code>Access-Control-Allow-Origin</code> for this page, answers a <code>Range</code> request with <code>206 Partial Content</code>, and
        lists <code>Content-Range</code> in <code>Access-Control-Expose-Headers</code> so that the size can be read. A server that ignores Range
        answers 200 with the whole file, which the source refuses with <code>unexpected-status</code>. On a Node server there is no CORS: pass a
        presigned URL.
      </p>
      <Snippet title={`Code: ${MODE_LABEL[mode]} from a URL`} pair={urlSnippet(mode)} />
      <form className="settings url-form" onSubmit={analyze} aria-label="Analyze a URL">
        <div className="fields">
          <label className="wide">
            <span>URL</span>
            <input type="url" required value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} />
          </label>
          <label>
            <span>Sample on this site</span>
            <select value={SAMPLES.find((s) => sampleUrl(s) === url) ?? ''} onChange={(e) => e.target.value && setUrl(sampleUrl(e.target.value))}>
              <option value="">(your URL)</option>
              {SAMPLES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Analysis</span>
            <select value={mode} onChange={(e) => setMode(e.target.value as UrlMode)}>
              {(Object.keys(MODE_LABEL) as UrlMode[]).map((m) => (
                <option key={m} value={m}>
                  {MODE_LABEL[m]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p>
          <button type="submit" disabled={busy}>
            {busy ? 'Reading...' : 'Analyze URL'}
          </button>
        </p>
      </form>
      <div className="list">
        {runs.map((run) =>
          run.result ? (
            <SubCard key={run.id} r={run.result} extra={`, ${run.requests} HTTP request${run.requests === 1 ? '' : 's'} (${run.mode})`} />
          ) : (
            <p key={run.id} className="err">
              {run.url}: {run.error}
            </p>
          ),
        )}
      </div>
    </div>
  );
}
