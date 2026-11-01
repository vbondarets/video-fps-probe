import { useEffect, useMemo, useState } from 'react';
import { analyzeHeader, HEADER_DEFAULT_LIMITS, isAbortError, type HeaderResult } from 'video-fps-probe/header';
import { setExtra } from './extras.ts';
import { bytes } from './format.ts';
import Snippet from './Snippet.tsx';
import { headerSnippet, LIMIT_KEYS, LIMIT_PRESETS, type FragmentedDurationMode, type HeaderSettings, type LimitValues } from './snippets.ts';
import { useFiles } from './store.ts';
import SubCard from './SubCard.tsx';

type LimitKey = (typeof LIMIT_KEYS)[number];
type Form = Record<LimitKey, string>;
type Outcome = HeaderResult | { failed: string };

const HELP: Record<LimitKey, string> = {
  maxBytes: 'bytes requested, read-ahead included',
  maxReads: 'reads issued',
  maxMs: 'milliseconds from the call',
  maxTracks: 'trak boxes in the moov',
  maxTopLevelBoxes: 'top-level box headers visited',
};

const DEFAULT_HINT: Record<LimitKey, string> = {
  maxBytes: bytes(HEADER_DEFAULT_LIMITS.maxBytes),
  maxReads: String(HEADER_DEFAULT_LIMITS.maxReads),
  maxMs: `${HEADER_DEFAULT_LIMITS.maxMs} ms`,
  maxTracks: String(HEADER_DEFAULT_LIMITS.maxTracks),
  maxTopLevelBoxes: String(HEADER_DEFAULT_LIMITS.maxTopLevelBoxes),
};

const formOf = (limits: LimitValues): Form => Object.fromEntries(LIMIT_KEYS.map((k) => [k, limits[k] === undefined ? '' : String(limits[k])])) as Form;

function parseLimits(form: Form): { limits: LimitValues } | { error: string } {
  const limits: LimitValues = {};
  for (const k of LIMIT_KEYS) {
    const text = form[k].trim();
    if (text === '') continue;
    const n = text === 'Infinity' ? Infinity : Number(text);
    if (n !== Infinity && !(Number.isSafeInteger(n) && n >= 0)) return { error: `${k} must be a whole number of 0 or more, or Infinity, got ${text}` };
    limits[k] = n;
  }
  return { limits };
}

const isResult = (o: Outcome | undefined): o is HeaderResult => !!o && !('failed' in o);

interface Inputs {
  form: Form;
  fragmentedDuration: FragmentedDurationMode;
  color: boolean;
  aspect: boolean;
}

const INITIAL: Inputs = { form: formOf(LIMIT_PRESETS[0]!.limits), fragmentedDuration: 'index', color: true, aspect: true };

export default function HeaderPanel() {
  const files = useFiles();
  const [inputs, setInputs] = useState<Inputs>(INITIAL);
  const [shown, setShown] = useState<HeaderSettings>(() => ({ limits: LIMIT_PRESETS[0]!.limits, fragmentedDuration: 'index', color: true, aspect: true }));
  const [outcomes, setOutcomes] = useState<{ settings: HeaderSettings | null; byRow: Record<number, Outcome> }>({ settings: null, byRow: {} });
  const parsed = parseLimits(inputs.form);
  const { form, fragmentedDuration, color, aspect } = inputs;

  const update = (change: Partial<Inputs>) => {
    const next = { ...inputs, ...change };
    setInputs(next);
    const p = parseLimits(next.form);
    if ('limits' in p) setShown({ limits: p.limits, fragmentedDuration: next.fragmentedDuration, color: next.color, aspect: next.aspect });
  };

  useEffect(() => {
    const controller = new AbortController();
    for (const { id, file } of files) {
      const record = (o: Outcome) => setOutcomes((prev) => (prev.settings === shown ? { settings: shown, byRow: { ...prev.byRow, [id]: o } } : { settings: shown, byRow: { [id]: o } }));
      analyzeHeader(file, { name: file.name, signal: controller.signal, ...shown }).then(record, (e: unknown) => {
        if (!controller.signal.aborted || !isAbortError(e)) record({ failed: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
      });
    }
    return () => controller.abort();
  }, [shown, files]);

  const current = outcomes.settings === shown ? outcomes.byRow : {};
  const exported = useMemo(() => {
    const byRow = outcomes.settings === shown ? outcomes.byRow : {};
    const results = files.map((f) => byRow[f.id]).filter(isResult);
    const limits = Object.fromEntries(Object.entries(shown.limits).map(([k, v]) => [k, v === Infinity ? 'Infinity' : v]));
    return results.length > 0 ? { settings: { ...shown, limits }, results } : undefined;
  }, [outcomes, files, shown]);

  useEffect(() => setExtra('header', exported), [exported]);

  const set = (k: LimitKey, v: string) => update({ form: { ...form, [k]: v } });

  return (
    <div className="panel-body">
      <p className="intro">
        <code>analyzeHeader</code> from <code>video-fps-probe/header</code> reads only the container header of an MP4 or MOV file, in this
        thread, under hard limits on the bytes, the reads, the time, the tracks and the top-level boxes. Its cost does not grow with the length
        of the video, so a server can check every upload cheaply. A limit that is reached gives a coded error instead of a hang. WebM and
        Matroska answer <code>unsupported-container</code>: use the full analysis for them.
      </p>
      <Snippet title="Code: header-only analysis with these settings" pair={headerSnippet(shown)} />
      <form className="settings" onSubmit={(e) => e.preventDefault()} aria-label="Header limits">
        <div className="presets" role="group" aria-label="Limit presets">
          {LIMIT_PRESETS.map((p) => (
            <button type="button" key={p.id} onClick={() => update({ form: formOf(p.limits) })}>
              {p.label}
            </button>
          ))}
        </div>
        <div className="fields">
          {LIMIT_KEYS.map((k) => (
            <label key={k}>
              <span className="mono">{k}</span>
              <input type="text" inputMode="numeric" value={form[k]} placeholder={DEFAULT_HINT[k]} onChange={(e) => set(k, e.target.value)} />
              <small>{HELP[k]}</small>
            </label>
          ))}
          <label>
            <span className="mono">fragmentedDuration</span>
            <select value={fragmentedDuration} onChange={(e) => update({ fragmentedDuration: e.target.value as FragmentedDurationMode })}>
              <option value="index">index</option>
              <option value="header">header</option>
            </select>
            <small>index reads the fragment index for an exact duration, header stops at the first fragment</small>
          </label>
        </div>
        <div className="checks">
          <label>
            <input type="checkbox" checked={color} onChange={(e) => update({ color: e.target.checked })} /> <span className="mono">color</span> (withColor)
          </label>
          <label>
            <input type="checkbox" checked={aspect} onChange={(e) => update({ aspect: e.target.checked })} /> <span className="mono">aspect</span> (withAspect)
          </label>
        </div>
        <p className="mut small">An empty field keeps the default shown in it. Each change reads every file again.</p>
        {'error' in parsed && (
          <p className="err" aria-live="polite">
            {parsed.error}
          </p>
        )}
      </form>
      {files.length === 0 && <p className="mut">Add files above, or press Try sample files: each file is then read here as well.</p>}
      <div className="list">
        {files.map(({ id, file }) => {
          const o = current[id];
          if (!o) return null;
          if (isResult(o)) return <SubCard key={id} r={o} />;
          return (
            <p key={id} className="err">
              {file.name}: {o.failed}
            </p>
          );
        })}
      </div>
    </div>
  );
}
