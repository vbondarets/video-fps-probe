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

export function diffReports(committed: unknown, measured: unknown): ArmDiff[];

export function satisfies(version: string, range: string): boolean;

export function outsidePeers(peers: Record<string, string>, versions: Record<string, string | null | undefined>): string[];

export function renderSummary(arms: ArmDiff[], matrix?: { versions?: Record<string, string | null>; failures: string[] } | null, peers?: Record<string, string>): { markdown: string; ownChanged: boolean };
