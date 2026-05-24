import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/uxtest',
  timeout: 240_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' }
})
