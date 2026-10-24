export function parseBrowserFlags(value: string | null | undefined): string[];

export function headlessMode(exe: string | null | undefined, flags?: readonly string[]): string;

export function commandLine(script: string, argv: readonly string[], flags?: readonly string[]): string;
