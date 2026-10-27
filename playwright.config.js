import { defineConfig } from '@playwright/test'

// tests/audio  → Vite dev server (offline-render harness pages import src/ directly)
// tests/e2e    → the production build served by `vite preview`
export default defineConfig({
  testDir: 'tests',
  testMatch: ['audio/**/*.spec.js', 'e2e/**/*.spec.js'],
  timeout: 120_000,
  workers: 2,
  reporter: [['list']],
  use: {
    browserName: 'chromium',
    headless: true,
    launchOptions: { args: ['--autoplay-policy=user-gesture-required'] },
  },
  webServer: [
    { command: 'npx vite --port 5173 --strictPort', port: 5173, reuseExistingServer: true, timeout: 60_000 },
    { command: 'npx vite preview --port 4173 --strictPort', port: 4173, reuseExistingServer: true, timeout: 60_000 },
  ],
})
