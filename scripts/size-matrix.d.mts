import type { ConsumerFixture } from './consumers.mjs';

export interface Budget {
  key: string;
  limit: number;
  why: string;
  required?: boolean;
}

export const BUDGETS: Record<string, Budget[]>;

export const THIRD_PARTY_ENGINES: string[];

export function measuresThirdParty(fixture: Pick<ConsumerFixture, 'engines'>, key: string): boolean;

export const HASH_PLACEHOLDER: string;

export function normalizedName(name: string): string;

export function hashNormalizer(names: Iterable<string>): (text: string) => string;

export function moduleId(source: string, root: string): string;

export const COMMONJS_ENTRIES: [entry: string, file: string][];

export interface CommonJsSize {
  entry: string;
  file: string;
  files: number;
  raw: number;
  gzip: number;
  lazyFiles: number;
  lazyRaw: number;
  lazyGzip: number;
}

export function commonJsSizes(cjsDir: string): CommonJsSize[] | null;
