import { defineConfig } from 'vite'
import { resolve } from 'node:path'

// Relative base so the build works at https://<user>.github.io/gt3rs-engine-sound/ and locally.
export default defineConfig({
  base: './',
  build: {
    target: 'es2020',
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        slicer: resolve(import.meta.dirname, 'tools/slicer.html'),
      },
    },
  },
  server: { port: 5173, strictPort: true },
  test: {
    include: ['tests/unit/**/*.test.js'],
    environment: 'node',
  },
})
