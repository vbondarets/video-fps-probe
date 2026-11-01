import { useRef, useState } from 'react';
import type { SnippetPair } from './snippets.ts';

const LABELS = { browser: 'Browser', node: 'Node server' } as const;

function CodeBlock({ which, text }: { which: keyof typeof LABELS; text: string }) {
  const code = useRef<HTMLElement>(null);
  const [note, setNote] = useState('');
  const copy = () => {
    const write = navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject(new Error('no clipboard'));
    write.then(
      () => setNote('Copied.'),
      () => {
        if (code.current) getSelection()?.selectAllChildren(code.current);
        setNote('Copying is blocked here: the code is selected, press Ctrl+C or Cmd+C.');
      },
    );
  };
  return (
    <div className="code-block" data-snippet={which}>
      <div className="code-head">
        <h4>{LABELS[which]}</h4>
        <button type="button" onClick={copy}>
          Copy
        </button>
        <span className="mut small" aria-live="polite">
          {note}
        </span>
      </div>
      <pre>
        <code ref={code}>{text}</code>
      </pre>
    </div>
  );
}

export default function Snippet({ title, pair }: { title: string; pair: SnippetPair }) {
  return (
    <details className="code">
      <summary>{title}</summary>
      <CodeBlock which="browser" text={pair.browser} />
      <CodeBlock which="node" text={pair.node} />
    </details>
  );
}
