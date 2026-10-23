import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  plugins: [react()],
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
