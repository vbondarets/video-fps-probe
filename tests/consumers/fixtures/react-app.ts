import { Activity, createElement as h, memo, StrictMode, useState, version } from 'react';
import { createRoot } from 'react-dom/client';
import { lazyProbe } from 'video-fps-probe/lazy';
import { useVideoFps, VideoFpsProvider } from 'video-fps-probe/react';

const probe = lazyProbe();
const analyze = probe.analyze;
const calls: Array<{ name: string; aborted: boolean }> = [];
let held: { done: Promise<void>; release(): void } | null = null;
probe.analyze = (file, options) => {
  const call = { name: file instanceof File ? file.name : '', aborted: false };
  calls.push(call);
  options?.signal?.addEventListener('abort', () => (call.aborted = true));
  return held ? held.done.then(() => analyze(file, options)) : analyze(file, options);
};
window.__probe = probe;
window.__react = {
  version,
  calls,
  hold: () => {
    let release = (): void => {};
    held = { done: new Promise<void>((done) => (release = done)), release: () => release() };
  },
  release: () => {
    held?.release();
    held = null;
  },
};

function Picked({ file }: { file: File }) {
  const state = useVideoFps(file);
  return h('output', { 'data-name': file.name, 'data-status': state.status, 'data-state': state.status === 'pending' ? '' : JSON.stringify({ result: state.result, summary: state.summary, error: state.error?.code ?? null }) });
}

const MemoPicked = memo(Picked);

function Hidden() {
  const [file, setFile] = useState<File | null>(null);
  const [visible, setVisible] = useState(true);
  return h(
    'section',
    { id: 'activity' },
    h('input', { id: 'activity-file', type: 'file', onChange: (e: { currentTarget: HTMLInputElement }) => setFile(e.currentTarget.files?.[0] ?? null) }),
    h('button', { id: 'activity-toggle', onClick: () => setVisible((v) => !v) }, 'activity'),
    file ? h(Activity, { mode: visible ? 'visible' : 'hidden', children: h(MemoPicked, { file }) }) : null,
  );
}

function App() {
  const [files, setFiles] = useState<File[]>([]);
  const [shown, setShown] = useState(true);
  const [renders, setRenders] = useState(0);
  return h(
    'div',
    { 'data-renders': renders },
    h('input', { id: 'react-file', type: 'file', multiple: true, onChange: (e: { currentTarget: HTMLInputElement }) => setFiles([...(e.currentTarget.files ?? [])]) }),
    h('button', { id: 'toggle', onClick: () => setShown((s) => !s) }, 'toggle'),
    h('button', { id: 'rerender', onClick: () => setRenders((n) => n + 1) }, 'rerender'),
    shown ? files.map((file, i) => h(Picked, { key: `${i}:${file.name}`, file })) : null,
    Activity === undefined ? null : h(Hidden),
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(h(StrictMode, null, h(VideoFpsProvider, { probe }, h(App))));
