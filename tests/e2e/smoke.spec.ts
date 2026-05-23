import { test, expect, _electron as electron } from '@playwright/test'
import { resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'

const SCREENSHOTS = resolve(__dirname, '../screenshots')

test('window opens, sidecar healthy, sidebar loads real character data', async () => {
  await mkdir(SCREENSHOTS, { recursive: true })

  const root = resolve(__dirname, '../..')
  const app = await electron.launch({
    args: [resolve(root, 'out/main/main.js')],
    cwd: root,
    env: { ...process.env, NODE_ENV: 'test' }
  })

  try {
    const window = await app.firstWindow()
    await expect(window.getByTestId('sidecar-status')).toContainText('ok')

    // Sidebar loaded characters from /data/fchat.
    const picker = window.getByTestId('char-picker')
    await expect(picker).toBeVisible()
    await expect(picker).not.toContainText('Loading')
    await expect(picker).not.toContainText("Couldn't reach")

    // Default mode is editor — editor + preview panes visible.
    await expect(window.getByTestId('editor-pane')).toBeVisible()
    await expect(window.getByTestId('preview-pane')).toBeVisible()

    await window.screenshot({ path: resolve(SCREENSHOTS, 'editor-mode.png') })

    // Switch to logs mode — partner list populates.
    await window.getByRole('tab', { name: 'Logs' }).click()
    await expect(window.getByTestId('log-viewer')).toBeVisible()
    await expect(window.getByTestId('partner-list')).toBeVisible({ timeout: 5_000 })

    await window.screenshot({ path: resolve(SCREENSHOTS, 'logs-mode.png') })
  } finally {
    await app.close()
  }
})
