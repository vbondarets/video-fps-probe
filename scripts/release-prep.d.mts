export const GENERATED: string[];

export function releaseChangelog(text: string, version: string, date: string): string;

export function changelogSection(text: string, version: string): string;

export function localDate(now?: Date): string;
