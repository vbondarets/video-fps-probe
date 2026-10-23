import { configDefaults, defineConfig } from 'vitest/config'
import { srcAliases } from './scripts/src-aliases.mjs'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'tests/package/**'],
    alias: srcAliases(),
    testTimeout: 60000,
    passWithNoTests: true,
  },
})
