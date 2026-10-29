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
