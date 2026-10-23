export interface SourceAlias {
  find: RegExp;
  replacement: string;
}

export function sourceMap(root?: string): Record<string, string>;

export function srcAliases(root?: string): SourceAlias[];
