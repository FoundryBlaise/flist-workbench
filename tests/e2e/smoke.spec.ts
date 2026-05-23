import { test, expect, _electron as electron } from '@playwright/test'
import { resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'

const SCREENSHOTS = resolve(__dirname, '../screenshots')

test('app boots, sidebar loads, editor↔preview wired, F-list fetch lands', async () => {
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

    // Sidebar populates from /data/fchat.
    const picker = window.getByTestId('char-picker')
    await expect(picker).toBeVisible()
    await expect(picker).not.toContainText('Loading')

    // Editor + preview both render. Default sample BBCode renders to HTML.
    const editor = window.getByTestId('editor-cm').locator('.cm-content')
    const preview = window.getByTestId('preview-body')
    await expect(editor).toBeVisible()
    await expect(preview).toBeVisible()
    await expect(preview.locator('h2').first()).toContainText('F-list Workbench')

    // Toolbar wraps selection with BBCode. Select all → click B → preview bolds.
    await editor.click()
    await window.keyboard.press('ControlOrMeta+A')
    await window.getByRole('button', { name: 'Bold' }).click()
    await expect(preview.locator('strong').first()).toBeVisible()

    // Typing into the editor reflects into preview.
    await window.keyboard.press('ControlOrMeta+A')
    await window.keyboard.type('[i]hello[/i] world')
    await expect(preview).toContainText('hello world')
    await expect(preview.locator('em').first()).toHaveText('hello')

    await window.screenshot({ path: resolve(SCREENSHOTS, 'editor-mode.png') })

    // Live F-list fetch — Azure Viper is a real public profile.
    await window.getByTestId('profile-fetch-input').fill('Azure Viper')
    await window.getByRole('button', { name: /fetch profile/i }).click()
    await expect(window.locator('.doc-name')).toContainText('Azure Viper.bbcode', {
      timeout: 15_000
    })
    // BBCode source landed in the editor.
    await expect(editor).toContainText('[indent]', { timeout: 10_000 })
    // Preview shows rendered F-list content.
    await expect(preview).toContainText('Bianca Brenston')

    await window.screenshot({ path: resolve(SCREENSHOTS, 'profile-fetched.png') })

    // Switch to logs mode — partner list populates.
    await window.getByRole('tab', { name: 'Logs' }).click()
    await expect(window.getByTestId('log-viewer')).toBeVisible()
    await expect(window.getByTestId('partner-list')).toBeVisible({ timeout: 5_000 })
    await window.screenshot({ path: resolve(SCREENSHOTS, 'logs-mode.png') })
  } finally {
    await app.close()
  }
})
