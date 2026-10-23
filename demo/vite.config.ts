import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { srcAliases } from '../scripts/src-aliases.mjs'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  cacheDir: fileURLToPath(new URL('../node_modules/.vite', import.meta.url)),
  plugins: [react()],
  resolve: {
    alias: srcAliases(),
  },
  server: {
    fs: {
      allow: [REPO_ROOT],
    },
  },
  worker: {
    format: 'es',
    rolldownOptions: {
      output: {
        comments: { annotation: false },
      },
    },
  },
  build: {
    target: 'es2022',
  },
})
