import { useEffect, useMemo, useState } from 'react';
import type { FileResult } from 'video-fps-probe';
import { check, type CheckReport, type CheckRules } from 'video-fps-probe/check';
import { klingMotionControl, klingO1ReferenceVideo, runwayAleph2, seedance2ReferenceVideo, veoExtend, wan26ReferenceToVideoFal, type ProviderPreset } from 'video-fps-probe/presets';
import Snippet from './Snippet.tsx';
import { checkSnippet, type HdrPolicy, type SizeBasis } from './snippets.ts';
import { setExtra } from './extras.ts';
import { useStore } from './store.ts';

const presets = { klingO1ReferenceVideo, klingMotionControl, runwayAleph2, veoExtend, wan26ReferenceToVideoFal, seedance2ReferenceVideo } satisfies Record<string, ProviderPreset>;

type PresetName = keyof typeof presets;

const PRESETS = Object.keys(presets) as PresetName[];
const META_KEYS = ['color', 'sampleAspectRatio', 'displayAspectRatio', 'displayWidth', 'displayHeight', 'codecConfig'] as const;
const DEFAULT_RULES = { fps: { min: 24, max: 60 }, duration: { min: 1, max: 30 }, frameSize: { maxLongSide: 3840 }, sizeBasis: 'display', vfr: 'warn' };
const SIZE_BASES: SizeBasis[] = ['stored', 'display'];
const HDR_POLICIES: HdrPolicy[] = ['allow', 'warn', 'reject'];

const pretty = (rules: unknown): string => JSON.stringify(rules, null, 2);

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function choice<T extends string>(rules: Record<string, unknown> | null, key: 'sizeBasis' | 'hdr', allowed: readonly T[]): { value?: T; error?: string } {
  const v = rules?.[key];
  if (v === undefined) return {};
  if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return { value: v as T };
  return { error: `${key} must be ${allowed.join(', ').replace(/, (?=[^,]*$)/, ' or ')}, got ${JSON.stringify(v)}` };
}

const overridesOf = (rules: Record<string, unknown> | null) => ({ sizeBasis: choice(rules, 'sizeBasis', SIZE_BASES), hdr: choice(rules, 'hdr', HDR_POLICIES) });

function presetRules(name: PresetName | '', { sizeBasis, hdr }: { sizeBasis?: SizeBasis; hdr?: HdrPolicy }): Record<string, unknown> {
  return { ...(name ? presets[name].rules : DEFAULT_RULES), ...(sizeBasis && { sizeBasis }), ...(hdr && { hdr }) };
}

function stillPreset(name: PresetName | '', text: string): boolean {
  if (!name) return false;
  const parsed = parseRules(text);
  if (!('rules' in parsed)) return false;
  const { sizeBasis, hdr } = overridesOf(parsed.rules);
  return sameJson(parsed.rules, presetRules(name, { sizeBasis: sizeBasis.value, hdr: hdr.value }));
}

function withoutMeta(r: FileResult): FileResult {
  const strip = (t: FileResult['videoTracks'][number]) => {
    const copy = { ...t };
    for (const k of META_KEYS) delete copy[k];
    return copy;
  };
  return { ...r, videoTracks: r.videoTracks.map(strip) };
}

function parseRules(text: string): { rules: Record<string, unknown> } | { error: string } {
  try {
    const rules: unknown = JSON.parse(text);
    if (!rules || typeof rules !== 'object' || Array.isArray(rules)) return { error: 'The rules must be a JSON object.' };
    return { rules: rules as Record<string, unknown> };
  } catch (e) {
    return { error: `Not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function judge(result: FileResult, rules: Record<string, unknown>): CheckReport | string {
  try {
    return check(result, rules as CheckRules);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

const shownValue = (v: unknown): string => (v === null || v === undefined ? '-' : Array.isArray(v) ? v.join(', ') : String(v));

function Report({ name, report }: { name: string; report: CheckReport | string }) {
  if (typeof report === 'string') {
    return (
      <p className="err">
        {name}: {report}
      </p>
    );
  }
  return (
    <article className="sub report" data-name={name}>
      <header>
        <h3>{name}</h3>
        <span className={`badge verdict ${report.verdict}`}>{report.verdict}</span>
      </header>
      {report.violations.length === 0 ? (
        <p className="mut">Every rule passed.</p>
      ) : (
        <ul className="violations">
          {report.violations.map((v, i) => (
            <li key={i} className={v.severity}>
              <span className={`badge sev ${v.severity}`}>{v.severity}</span> {v.message}
              {v.severity !== 'unknown' && (
                <small>
                  {' '}
                  expected {shownValue(v.expected)}, actual {shownValue(v.actual)}
                </small>
              )}
            </li>
          ))}
        </ul>
      )}
      {report.suggestedFps && <p className="mut small">Suggested: {report.suggestedFps.reason}</p>}
    </article>
  );
}

export default function CheckPanel() {
  const { rows } = useStore();
  const [preset, setPreset] = useState<PresetName | ''>('');
  const [text, setText] = useState(() => pretty(DEFAULT_RULES));
  const [withMeta, setWithMeta] = useState(true);
  const parsed = useMemo(() => parseRules(text), [text]);
  const rules = 'rules' in parsed ? parsed.rules : null;
  const overrides = overridesOf(rules);
  const sizeBasis = overrides.sizeBasis.value;
  const hdr = overrides.hdr.value;
  const invalid = [overrides.sizeBasis.error, overrides.hdr.error].filter((e): e is string => e !== undefined);

  const reports = useMemo(
    () => (rules ? rows.flatMap((row) => (row.result ? [{ name: row.file.name, report: judge(withMeta ? row.result : withoutMeta(row.result), rules) }] : [])) : []),
    [rows, rules, withMeta],
  );

  useEffect(() => {
    setExtra('check', reports.length > 0 && rules ? { rules, withColorAndAspect: withMeta, reports } : undefined);
  }, [reports, rules, withMeta]);

  const choosePreset = (name: PresetName | '') => {
    setPreset(name);
    setText(pretty(presetRules(name, { sizeBasis, hdr })));
  };

  const edit = (next: string) => {
    setText(next);
    if (!stillPreset(preset, next)) setPreset('');
  };

  const setKey = (key: 'sizeBasis' | 'hdr', value: string) => {
    if (!rules) return;
    const next: Record<string, unknown> = { ...rules };
    if (value) next[key] = value;
    else delete next[key];
    edit(pretty(next));
  };

  const note = preset ? presets[preset].note : null;
  return (
    <div className="panel-body">
      <p className="intro">
        <code>check()</code> from <code>video-fps-probe/check</code> judges a result against upload rules: frame rate, duration, frame size,
        aspect ratio, pixels, file size, container, codec, audio, variable or uneven frame rate and HDR. The rules are plain JSON, so a server
        can send them. A rule that cannot be judged because a field is missing comes back as <code>unknown</code> with a hint, never as a guess.
        The presets carry the published input limits of video generation APIs.
      </p>
      <Snippet title="Code: check an upload with these rules" pair={checkSnippet(preset || null, { sizeBasis, hdr })} />
      <form className="settings" onSubmit={(e) => e.preventDefault()} aria-label="Check rules">
        <div className="fields">
          <label>
            <span>Preset</span>
            <select value={preset} onChange={(e) => choosePreset(e.target.value as PresetName | '')}>
              <option value="">custom rules</option>
              {PRESETS.map((p) => (
                <option key={p} value={p}>
                  {presets[p].name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="mono">sizeBasis</span>
            <select value={sizeBasis ?? ''} disabled={!rules} onChange={(e) => setKey('sizeBasis', e.target.value)}>
              <option value="">(not set: stored)</option>
              {SIZE_BASES.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
            <small>display judges the size a player shows, from withAspect</small>
          </label>
          <label>
            <span className="mono">hdr</span>
            <select value={hdr ?? ''} disabled={!rules} onChange={(e) => setKey('hdr', e.target.value)}>
              <option value="">(not set: allow)</option>
              {HDR_POLICIES.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
            <small>PQ, HLG and Dolby Vision, from withColor</small>
          </label>
        </div>
        <div className="checks">
          <label>
            <input type="checkbox" checked={withMeta} onChange={(e) => setWithMeta(e.target.checked)} /> Judge with color and aspect (
            <span className="mono">codecConfig: true</span>, withColor, withAspect)
          </label>
        </div>
        <label className="block">
          <span>Rules (JSON)</span>
          <textarea rows={10} value={text} spellCheck={false} onChange={(e) => edit(e.target.value)} />
        </label>
        {note && <p className="mut small">{note}</p>}
        {'error' in parsed && (
          <p className="err" aria-live="polite">
            {parsed.error}
          </p>
        )}
        {invalid.map((e) => (
          <p key={e} className="err" aria-live="polite">
            {e}
          </p>
        ))}
      </form>
      {rows.every((r) => !r.result) && <p className="mut">Add files above, or press Try sample files: each analyzed file is judged here.</p>}
      <div className="list">
        {reports.map((r, i) => (
          <Report key={i} name={r.name} report={r.report} />
        ))}
      </div>
    </div>
  );
}
