import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { MatroskaMode } from './core/types.ts';
import { bytes, ms, PROVENANCE } from './ui/format.ts';
import type { ExportAction, ExportOutcome } from './ui/deviceInfo.ts';
import { Mark, ResultCard } from './ui/ResultCard.tsx';
import { loadSamples } from './ui/samples.ts';
import { addFiles, clearAll, exportJson, loadDevice, setMode, useStore } from './ui/store.ts';

const MODES: MatroskaMode[] = ['auto', 'header', 'probe', 'exact'];
const REPO = 'https://github.com/vbondarets/video-fps-probe';

function hasFiles(e: DragEvent): boolean {
  return e.dataTransfer?.types.includes('Files') ?? false;
}

export default function App() {
  const { rows, mode } = useStore();
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
    loadSamples().then(addFiles, (e: unknown) => setNotice(`Could not load samples: ${e instanceof Error ? e.message : String(e)}`));
  };

  const exportAs = (action: ExportAction) => {
    exportJson(action).then(setExported, (e: unknown) =>
      setExported({ ok: false, message: `Export failed: ${e instanceof Error ? e.message : String(e)}`, text: null }),
    );
  };

  const done = rows.filter((r) => r.result);
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
        <button type="button" onClick={() => exportAs('download')} disabled={done.length === 0}>
          Download JSON
        </button>
        <button type="button" onClick={() => exportAs('copy')} disabled={done.length === 0}>
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
      <p className="mut small">Sample files are fetched into memory as blobs, so their reads never touch the disk and timings are optimistic.</p>
      {notice && <p className="err">{notice}</p>}
      {exported && (
        <div className="export-note" role="status">
          <p className={exported.ok ? 'mut small' : 'err'}>{exported.message}</p>
          {exported.text !== null && <textarea readOnly rows={8} value={exported.text} aria-label="Results JSON" onFocus={(e) => e.currentTarget.select()} />}
        </div>
      )}

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

      <footer className="small">
        <p>
          Each file is opened with <code>Blob.slice</code> inside a Web Worker. The container headers (MP4 sample tables or fragment
          runs, Matroska tracks and block timestamps) give every frame timestamp, so the average, minimum, maximum and variable frame
          rate are computed without decoding a single frame. Results are checked against ffprobe 8.1.1.
        </p>
        <p>
          <a href={REPO}>{REPO}</a>
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
