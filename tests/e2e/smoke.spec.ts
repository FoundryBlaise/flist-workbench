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
    await expect(preview.locator('.bb-heading').first()).toContainText('F-list Workbench')

    // Toolbar wraps selection with BBCode. Select all → click B → preview bolds.
    await editor.click()
    await window.keyboard.press('ControlOrMeta+A')
    await window.getByRole('button', { name: 'Bold' }).click()
    await expect(preview.locator('strong').first()).toBeVisible()

    // Typing into the editor reflects into preview.
    await window.keyboard.press('ControlOrMeta+A')
    await window.keyboard.type('[b]hello[/b] world')
    await expect(preview).toContainText('hello world')
    await expect(preview.locator('strong').first()).toHaveText('hello')

    // Bidirectional: edit the preview span and confirm the editor updates.
    // We poke the DOM directly + dispatch input — this is the same path
    // the contentEditable handler follows when a user types in-place.
    await window.evaluate(() => {
      const span = document.querySelector(
        '[data-testid="preview-body"] [data-bb-start]'
      ) as HTMLElement | null
      if (!span) throw new Error('no data-bb span in preview')
      span.focus()
      span.textContent = 'HELLO'
      span.dispatchEvent(new Event('input', { bubbles: true }))
    })
    // CodeMirror's content lives in .cm-content as visible text.
    await expect(editor).toContainText('[b]HELLO[/b]')

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

    // Switch to logs mode — partner list populates from real /data/fchat.
    await window.getByRole('tab', { name: 'Logs' }).click()
    await expect(window.getByTestId('log-viewer')).toBeVisible()
    const partnerList = window.getByTestId('partner-list')
    await expect(partnerList).toBeVisible({ timeout: 5_000 })

    // Click the first non-channel partner — those have parseable logs.
    const partners = partnerList.locator('li button')
    const partnerCount = await partners.count()
    expect(partnerCount).toBeGreaterThan(0)
    let opened = false
    for (let i = 0; i < partnerCount; i++) {
      const label = await partners.nth(i).locator('.label').textContent()
      if (label && !label.startsWith('#')) {
        await partners.nth(i).click()
        opened = true
        break
      }
    }
    expect(opened).toBe(true)

    // Real log lands — IC / OOC pills appear in the header.
    const logBody = window.getByTestId('log-body')
    await expect(logBody).toBeVisible({ timeout: 15_000 })
    await expect(window.locator('.log-pill').filter({ hasText: /^IC \d/ })).toBeVisible()
    // At least one message rendered.
    await expect(logBody.locator('.log-msg').first()).toBeVisible({ timeout: 10_000 })

    await window.screenshot({ path: resolve(SCREENSHOTS, 'logs-mode.png') })
  } finally {
    await app.close()
  }
})
