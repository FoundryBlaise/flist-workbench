import { test, expect, _electron as electron } from '@playwright/test'
import { resolve } from 'node:path'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'

const SCREENSHOTS = resolve(__dirname, '../screenshots')

// Right-click on the conversation pane (anywhere, not just the
// header) opens the conversation context menu with Classify + Reset
// actions. Smoke-tests the wiring after the move from .log-head to
// the outer .pane.log-pane handler.
test('conversation pane right-click shows Classify menu', async () => {
  await mkdir(SCREENSHOTS, { recursive: true })

  const root = resolve(__dirname, '../..')
  const dataDir = await mkdtemp(resolve(tmpdir(), 'flist-workbench-convmenu-'))
  const app = await electron.launch({
    args: [resolve(root, 'out/main/main.js')],
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      FLIST_WORKBENCH_DATA_DIR: dataDir,
      // Point at the real fixture corpus so we have a conversation to
      // open. ~18 kb partner picked for a non-trivial render.
      FCHAT_DATA_DIR: '/sideprojects/rag/data'
    }
  })

  try {
    const window = await app.firstWindow()
    window.on('dialog', (d) => {
      void d.accept()
    })
    await expect(window.getByTestId('sidecar-status')).toContainText('ok')

    // Switch to Logs. Default character + first partner is enough —
    // we're testing the menu wiring, not a specific conversation.
    await window.getByRole('tab', { name: 'Logs' }).click()
    const partners = window
      .getByTestId('partner-list-people')
      .locator('li button.sb-item')
    await expect(partners.first()).toBeVisible({ timeout: 10_000 })
    await partners.first().click()

    const logBody = window.getByTestId('log-body')
    await expect(logBody).toBeVisible({ timeout: 15_000 })
    await expect(logBody.locator('.log-msg').first()).toBeVisible({
      timeout: 10_000
    })

    // Right-click in the empty area below messages (NOT on a row).
    // The old wiring on .log-head wouldn't have fired here.
    const filterStrip = window.locator('.log-filters')
    await filterStrip.click({ button: 'right' })

    const convMenu = window.getByTestId('log-conv-menu')
    await expect(convMenu).toBeVisible()
    await expect(window.getByTestId('log-conv-menu-classify')).toBeVisible()
    await expect(window.getByTestId('log-conv-menu-reset-all')).toBeVisible()
    await window.screenshot({
      path: resolve(SCREENSHOTS, 'conv-context-menu-open.png')
    })

    // Esc closes the menu.
    await window.keyboard.press('Escape')
    await expect(convMenu).not.toBeVisible()

    // Right-click on a message row should NOT open the conv menu —
    // the per-message label menu fires instead.
    await logBody.locator('.log-msg').first().click({ button: 'right' })
    await expect(window.getByTestId('log-label-menu')).toBeVisible()
    await expect(convMenu).not.toBeVisible()
    await window.keyboard.press('Escape')

    // Right-click on a partner row in the sidebar should open the
    // partner-row context menu with Classify + Reset all options,
    // scoped to that partner — regardless of which one is currently
    // open in the pane.
    const otherPartner = partners.nth(1)
    if ((await partners.count()) >= 2) {
      await otherPartner.click({ button: 'right' })
      const partnerMenu = window.getByTestId('partner-context-menu')
      await expect(partnerMenu).toBeVisible()
      await expect(window.getByTestId('partner-context-menu-classify')).toBeVisible()
      await expect(window.getByTestId('partner-context-menu-reset')).toBeVisible()
      await window.screenshot({
        path: resolve(SCREENSHOTS, 'partner-context-menu-open.png')
      })
      await window.keyboard.press('Escape')
      await expect(partnerMenu).not.toBeVisible()
    }
  } finally {
    await app.close()
  }
})
