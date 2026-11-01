import { useSyncExternalStore } from 'react';

export type Extras = Readonly<Record<string, unknown>>;

let extras: Extras = {};
const listeners = new Set<() => void>();

export function setExtra(key: string, value: unknown): void {
  if (extras[key] === value) return;
  const next: Record<string, unknown> = { ...extras, [key]: value };
  if (value === undefined) delete next[key];
  extras = next;
  listeners.forEach((l) => l());
}

export const getExtras = (): Extras => extras;

export function useExtras(): Extras {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => extras,
  );
}
