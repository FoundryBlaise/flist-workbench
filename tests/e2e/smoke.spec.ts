import { test, expect, _electron as electron } from '@playwright/test'
import { resolve } from 'node:path'

test('window opens and sidecar reports healthy', async () => {
  const root = resolve(__dirname, '../..')
  const app = await electron.launch({
    args: [resolve(root, 'out/main/main.js')],
    cwd: root,
    env: { ...process.env, NODE_ENV: 'test' }
  })

  try {
    const window = await app.firstWindow()
    await expect(window.getByTestId('sidecar-status')).toContainText('ok')
  } finally {
    await app.close()
  }
})
