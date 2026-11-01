import react from '@vitejs/plugin-react'
import { extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Connect, type Plugin } from 'vite'
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

const MEDIA_TYPES: Readonly<Record<string, string>> = { '.mkv': 'video/x-matroska' }

function mediaTypes(): Plugin {
  const typed: Connect.NextHandleFunction = (req, res, next) => {
    const type = MEDIA_TYPES[extname(new URL(req.url ?? '/', 'http://localhost').pathname).toLowerCase()]
    if (type) res.setHeader('Content-Type', type)
    next()
  }
  return {
    name: 'media-types',
    configureServer: (server) => {
      server.middlewares.use(typed)
    },
    configurePreviewServer: (server) => {
      server.middlewares.use(typed)
    },
  }
}

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  cacheDir: fileURLToPath(new URL('../node_modules/.vite', import.meta.url)),
  plugins: [react(), buildStamp(), mediaTypes()],
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
