export interface ConsumerFixture {
  name: string;
  imports: string[];
  note?: string;
  worker: string;
  engines: Array<'own' | 'mp4box' | 'mediabunny' | 'rvfc'>;
  workers: string[];
  singleFileWorkers?: boolean;
  mustNot: string[];
}

export const OWN_WORKERS: Record<'isobmff' | 'matroska', string>;

export const WORKER_MUST_NOT: Record<string, string[]>;

export const FIXTURES: ConsumerFixture[];

export const CONSUMERS_PORT: number;

export function lockedOverrides(direct?: string[]): Record<string, string>;

export const REACT_18_PINS: Record<string, string>;

export const LATEST: string[];

export function latestPins(dir: string): Record<string, string> | null;

export function pinDrift(dir: string): string[];

export function consumersDir(arg?: string): string;

export function fixtureRoot(dir: string, name: string): string;

export function fixtureDist(dir: string, name: string): string;

export function installedPackage(dir: string): string;

export function buildUrl(port: number, name: string): string;

export function devUrl(port: number, name: string): string;

export function setup(dir: string, options?: { latest?: boolean }): void;

export function copyFixtures(dir: string, names?: string[]): void;

export function build(dir: string, names?: string[]): void;

export function serve(dir: string, port: number): Promise<void>;
