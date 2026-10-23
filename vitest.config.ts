import { defineConfig } from 'vitest/config'
import { srcAliases } from './scripts/src-aliases.mjs'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    alias: srcAliases(),
    testTimeout: 60000,
    passWithNoTests: true,
  },
})
