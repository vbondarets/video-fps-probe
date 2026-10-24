import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import { srcAliases } from '../scripts/src-aliases.mjs'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

function buildStamp(): Plugin {
  const stamp = { 'build-time': process.env.VITE_BUILD_TIME, 'build-commit': process.env.VITE_COMMIT }
  return {
    name: 'build-stamp',
    transformIndexHtml: () =>
      Object.entries(stamp).flatMap(([name, content]) => (content ? [{ tag: 'meta', attrs: { name, content }, injectTo: 'head' as const }] : [])),
  }
}

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  cacheDir: fileURLToPath(new URL('../node_modules/.vite', import.meta.url)),
  plugins: [react(), buildStamp()],
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
    modulePreload: { polyfill: false },
  },
})
