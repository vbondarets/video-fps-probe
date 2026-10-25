export const GENERATED: string[];

export function unreleasedIntro(text: string): string;

export function releaseChangelog(text: string, version: string, date: string): string;

export function gitIdentity(configValue: (key: string) => string): string;

export function publicManifest(manifest: { private?: unknown }): void;

export function changelogSection(text: string, version: string): string;

export function repositoryUrl(manifest: { repository?: string | { url?: string } }): string;

export function releaseNotes(text: string, version: string, repository: string): string;

export function writeNotes(text: string, version: string, out: string, repository: string): string;

export function localDate(now?: Date): string;

export function publishCheck(manifest: { version: string; private?: unknown }, tag: string, npmVersion: string): 'next' | 'latest';
