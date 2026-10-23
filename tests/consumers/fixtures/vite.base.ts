import { mergeConfig, type UserConfig } from 'vite';

export function consumerConfig(overrides: UserConfig = {}): UserConfig {
  return mergeConfig(
    {
      base: './',
      cacheDir: 'node_modules/.vite',
      logLevel: 'warn',
      build: { sourcemap: 'hidden', modulePreload: { polyfill: false }, reportCompressedSize: false },
    } satisfies UserConfig,
    overrides,
  );
}
