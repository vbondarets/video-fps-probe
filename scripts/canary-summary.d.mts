export interface CheckChange {
  check: string;
  before: string | null;
  after: string | null;
}

export interface ArmDiff {
  engine: string;
  own: boolean;
  version: { before: string | null; after: string | null };
  loadSkipped: { before: string | null; after: string | null };
  compared: number;
  counts: { before: Record<string, number>; after: Record<string, number> };
  changed: { fixture: string; checks: CheckChange[] }[];
}

export interface SmokeRun {
  browser: string;
  fixture: string;
  mode: 'build' | 'dev';
  file: string;
  engine: 'mp4box' | 'mediabunny';
  outcome: 'equal' | 'differs' | 'error' | 'threw';
  detail: string | null;
}

export interface EngineBudget {
  fixture: string;
  key: string;
  label: string;
  limit: number;
  gzip: number | null;
  status: 'ok' | 'over' | 'missing' | 'not built';
}

export interface EngineBudgetRow extends EngineBudget {
  before: number | null;
}

export interface SummaryMatrix {
  versions?: Record<string, string | null>;
  failures: string[];
  informational?: EngineBudget[];
}

export interface CommittedMatrix {
  versions?: Record<string, string | null>;
  fixtures?: { name: string; budgets: { key: string; gzip: number | null }[] }[];
}

export function diffReports(committed: unknown, measured: unknown): ArmDiff[];

export function satisfies(version: string, range: string): boolean;

export function outsidePeers(peers: Record<string, string>, versions: Record<string, string | null | undefined>): string[];

export function readSmoke(dir: string): SmokeRun[];

export function renderSmoke(runs: readonly SmokeRun[]): string[];

export function engineBudgetRows(matrix: SummaryMatrix | null, committed?: CommittedMatrix | null): EngineBudgetRow[];

export function renderEngineBudgets(rows: readonly EngineBudgetRow[], matrix?: SummaryMatrix | null, committed?: CommittedMatrix | null): string[];

export function renderSummary(arms: ArmDiff[], matrix?: SummaryMatrix | null, peers?: Record<string, string>, smoke?: readonly SmokeRun[] | null, committedMatrix?: CommittedMatrix | null): { markdown: string; ownChanged: boolean };
