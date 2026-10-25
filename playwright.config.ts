import { defineConfig } from '@playwright/test'

// The app under test is the built Electron app (`npm run build`).
// Global setup builds a fixture F-Chat folder in a fresh temp root;
// every spec launches through tests/e2e/launch.ts, which gives the app
// fresh temp data folders there. No run reads or writes the user's own
// data. Screenshots are taken only when a test fails (see withApp in
// launch.ts; Playwright's own `screenshot` option does not reach
// Electron windows), and land in test-results/ with the trace.
export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' }
})
