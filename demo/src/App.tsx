import { useEffect, useRef, useState, type ChangeEvent, type FC, type KeyboardEvent } from 'react';
import type { MatroskaMode } from 'video-fps-probe';
import { bytes, ms, PROVENANCE } from './ui/format.ts';
import type { ExportAction, ExportOutcome } from './ui/deviceInfo.ts';
import { useExtras } from './ui/extras.ts';
import { Mark } from './ui/cells.tsx';
import { ResultCard } from './ui/ResultCard.tsx';
import { retryable } from './ui/retryable.tsx';
import { addFiles, clearAll, exportJson, loadDevice, setMode, useStore } from './ui/store.ts';

const MODES: MatroskaMode[] = ['auto', 'header', 'probe', 'exact'];
const REPO = 'https://github.com/vbondarets/video-fps-probe';
const LOADING = <p className="mut">Loading...</p>;

type Tab = 'files' | 'header' | 'url' | 'check' | 'errors';

const TABS: readonly (readonly [Tab, string])[] = [
  ['files', 'Files'],
  ['header', 'Header only'],
  ['url', 'From a URL'],
  ['check', 'Check rules'],
  ['errors', 'Error codes'],
];

const PANELS: Record<Exclude<Tab, 'files'>, FC<object>> = {
  header: retryable(() => import('./ui/HeaderPanel.tsx'), LOADING),
  url: retryable(() => import('./ui/UrlPanel.tsx'), LOADING),
  check: retryable(() => import('./ui/CheckPanel.tsx'), LOADING),
  errors: retryable(() => import('./ui/ErrorsPanel.tsx'), LOADING),
};
const FilesIntro = retryable<object>(() => import('./ui/FilesIntro.tsx'));

const tabOfHash = (): Tab => {
  const hash = location.hash.slice(1);
  return TABS.find(([t]) => t === hash)?.[0] ?? 'files';
};

function hasFiles(e: DragEvent): boolean {
  return e.dataTransfer?.types.includes('Files') ?? false;
}

export default function App() {
  const { rows, mode, redeployed } = useStore();
  const extras = useExtras();
  const [tab, setTab] = useState<Tab>(tabOfHash);
  const [visited, setVisited] = useState<ReadonlySet<Tab>>(() => new Set([tab]));
  const tabButtons = useRef(new Map<Tab, HTMLButtonElement>());
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState('');
  const [exportNote, setExportNote] = useState<{ rows: number; outcome: ExportOutcome } | null>(null);
  const [envLine, setEnvLine] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const deviceRequested = useRef(false);
  const hasResult = rows.some((r) => r.result);

  useEffect(() => {
    if (!hasResult || deviceRequested.current) return;
    deviceRequested.current = true;
    const load = () => loadDevice().then((d) => d.watchEnvironmentLine(setEnvLine), () => {});
    if (typeof requestIdleCallback === 'function') requestIdleCallback(load, { timeout: 1000 });
    else setTimeout(load, 0);
  }, [hasResult]);

  const exported = exportNote && exportNote.rows === rows.length ? exportNote.outcome : null;
  const setExported = (outcome: ExportOutcome | null) => setExportNote(outcome ? { rows: rows.length, outcome } : null);

  useEffect(() => {
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (!e.relatedTarget) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragging(false);
      addFiles(Array.from(e.dataTransfer?.files ?? []));
    };
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, []);

  const pick = (e: ChangeEvent<HTMLInputElement>) => {
    addFiles(Array.from(e.target.files ?? []));
    e.target.value = '';
  };

  const samples = () => {
    setNotice('');
    import('./ui/samples.ts')
      .then((m) => m.loadSamples())
      .then(addFiles, (e: unknown) => setNotice(`Could not load samples: ${e instanceof Error ? e.message : String(e)}`));
  };

  const open = (next: Tab, focus = false) => {
    setTab(next);
    setVisited((v) => (v.has(next) ? v : new Set([...v, next])));
    history.replaceState(null, '', next === 'files' ? location.pathname + location.search : `#${next}`);
    if (focus) tabButtons.current.get(next)?.focus();
  };

  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = TABS.findIndex(([t]) => t === tab);
    const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    open(TABS[(to + TABS.length) % TABS.length]![0], true);
  };

  const exportAs = (action: ExportAction) => {
    exportJson(action).then(setExported, (e: unknown) =>
      setExported({ ok: false, message: `Export failed: ${e instanceof Error ? e.message : String(e)}`, text: null }),
    );
  };

  const done = rows.filter((r) => r.result);
  const exportable = done.length > 0 || Object.keys(extras).length > 0;
  const pending = rows.filter((r) => r.busy).length;
  const totalSize = done.reduce((n, r) => n + r.file.size, 0);
  const totalRead = done.reduce((n, r) => n + r.result!.io.bytesRead, 0);
  const totalMs = done.reduce((n, r) => n + r.result!.io.ms, 0);

  return (
    <main>
      <h1>Video FPS Probe</h1>
      <p className="lead">
        Frame rate of video files, computed in your browser. Nothing is uploaded or decoded; only the bytes needed are read.
      </p>

      {redeployed && (
        <p className="card" role="alert">
          A new version of this page was deployed. Reload to continue.{' '}
          <button type="button" onClick={() => location.reload()}>
            Reload
          </button>
        </p>
      )}

      <label className={`drop${dragging ? ' on' : ''}`}>
        <input ref={input} type="file" multiple data-testid="file-input" accept="video/*,audio/*,.mp4,.m4v,.mov,.webm,.mkv" onChange={pick} />
        <strong>Drop video files here</strong>
        <span>or click to choose files (several at once)</span>
      </label>

      <div className="toolbar">
        <button type="button" onClick={samples}>
          Try sample files
        </button>
        <label>
          Matroska scan{' '}
          <select value={mode} onChange={(e) => setMode(e.target.value as MatroskaMode)}>
            {MODES.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </label>
        <button type="button" onClick={() => exportAs('download')} disabled={!exportable}>
          Download JSON
        </button>
        <button type="button" onClick={() => exportAs('copy')} disabled={!exportable}>
          Copy JSON
        </button>
        <button
          type="button"
          onClick={() => {
            clearAll();
            setExported(null);
            input.current?.focus();
          }}
          disabled={rows.length === 0}
        >
          Clear list
        </button>
      </div>
      <p className="mut small">
        Sample files are fetched into memory as blobs, so their reads never touch the disk and timings are optimistic. The JSON export holds
        every tab: the full results, the header-only and URL results and the check reports.
      </p>
      {notice && <p className="err">{notice}</p>}
      {exported && (
        <div className="export-note" role="status">
          <p className={exported.ok ? 'mut small' : 'err'}>{exported.message}</p>
          {exported.text !== null && <textarea readOnly rows={8} value={exported.text} aria-label="Results JSON" onFocus={(e) => e.currentTarget.select()} />}
        </div>
      )}

      <div className="tabs" role="tablist" aria-label="What to try" onKeyDown={onTabKey}>
        {TABS.map(([t, label]) => (
          <button
            key={t}
            type="button"
            role="tab"
            id={`tab-${t}`}
            aria-controls={`panel-${t}`}
            aria-selected={tab === t}
            tabIndex={tab === t ? 0 : -1}
            ref={(el) => {
              if (el) tabButtons.current.set(t, el);
              else tabButtons.current.delete(t);
            }}
            onClick={() => open(t)}
          >
            {label}
          </button>
        ))}
      </div>

      <section className="panel" role="tabpanel" id="panel-files" aria-labelledby="tab-files" hidden={tab !== 'files'}>
      <p className="intro">
        The full analysis runs in a Web Worker and reads every frame timestamp from the container: average, nominal, minimum and maximum frame
        rate, VFR, the rate profile, the median frame interval and whether the track is enabled. With <code>codecConfig: true</code>,{' '}
        <code>withColor</code> adds the color signalling, HDR (PQ or HLG) and Dolby Vision as ffprobe prints them, and <code>withAspect</code>{' '}
        the sample and display aspect ratio and the display size.
      </p>
      <FilesIntro />
      <p className="summary" role="status">
        {rows.length === 0
          ? 'No files yet.'
          : `${rows.length} file${rows.length > 1 ? 's' : ''}${pending ? `, ${pending} analyzing` : ''}. Read ${bytes(totalRead)} of ${bytes(totalSize)}${totalSize ? ` (${((totalRead / totalSize) * 100).toFixed(2)}%)` : ''} in ${ms(totalMs)} total.`}
      </p>
      <p className="legend small">
        Value origin:{' '}
        {(Object.keys(PROVENANCE) as (keyof typeof PROVENANCE)[]).map((p) => (
          <span key={p}>
            <Mark p={p} /> {p}{' '}
          </span>
        ))}
      </p>

      <h2 className="sr">Results</h2>
      <section className="list" aria-label="Results">
        {rows.map((row) => (
          <ResultCard key={row.id} row={row} />
        ))}
      </section>
      </section>

      {(Object.keys(PANELS) as (keyof typeof PANELS)[]).map((t) => {
        const Panel = PANELS[t];
        return (
          <section key={t} className="panel" role="tabpanel" id={`panel-${t}`} aria-labelledby={`tab-${t}`} hidden={tab !== t}>
            {visited.has(t) && <Panel />}
          </section>
        );
      })}

      <footer className="small">
        <p>
          Each file is opened with <code>Blob.slice</code> inside a Web Worker. The container headers (MP4 sample tables or fragment
          runs, Matroska tracks and block timestamps) give every frame timestamp, so the average, minimum, maximum and variable frame
          rate are computed without decoding a single frame. Results are checked against ffprobe 8.1.1.
        </p>
        <p>
          <a href={REPO}>{REPO}</a> · <a href={`${REPO}/discussions`}>Questions and feedback</a>
        </p>
        {envLine && (
          <p className="env mono" data-testid="env-line">
            This device: {envLine}
          </p>
        )}
      </footer>
    </main>
  );
}
