import { createElement as h, StrictMode, useState, version } from 'react';
import { createRoot } from 'react-dom/client';
import { lazyProbe } from 'video-fps-probe/lazy';
import { useVideoFps, VideoFpsProvider } from 'video-fps-probe/react';

const probe = lazyProbe();
const analyze = probe.analyze;
const calls: Array<{ name: string; aborted: boolean }> = [];
probe.analyze = (file, options) => {
  const call = { name: file instanceof File ? file.name : '', aborted: false };
  calls.push(call);
  options?.signal?.addEventListener('abort', () => (call.aborted = true));
  return analyze(file, options);
};
window.__probe = probe;
window.__react = { version, calls };

function Picked({ file }: { file: File }) {
  const state = useVideoFps(file);
  return h('output', { 'data-name': file.name, 'data-status': state.status, 'data-state': state.status === 'pending' ? '' : JSON.stringify({ result: state.result, summary: state.summary, error: state.error?.code ?? null }) });
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
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(h(StrictMode, null, h(VideoFpsProvider, { probe }, h(App))));
