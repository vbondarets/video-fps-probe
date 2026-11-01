import { useEffect, useState, type FC, type ReactNode } from 'react';

export function retryable<P extends object>(load: () => Promise<{ default: FC<P> }>, fallback?: ReactNode): FC<P> {
  let Panel: FC<P> | undefined;
  const Retryable = (props: P) => {
    const [failed, setFailed] = useState<boolean>();
    useEffect(() => {
      if (Panel || failed) return;
      load().then(
        (m) => {
          Panel = m.default;
          setFailed(false);
        },
        () => setFailed(true),
      );
    }, [failed]);
    if (Panel) return <Panel {...props} />;
    if (!failed) return fallback;
    return (
      <p className="mut">
        {'Panel failed to load. '}
        <button type="button" onClick={() => setFailed(undefined)}>
          Retry
        </button>
      </p>
    );
  };
  return Retryable;
}
