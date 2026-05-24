import { test, expect, _electron as electron } from '@playwright/test'
import { resolve } from 'node:path'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'

const SCREENSHOTS = resolve(__dirname, '../screenshots')

// Send a menu action to the renderer the same way electron/menu.ts
// does. Returns true if a focused window received it. Lets the test
// trigger Classify dialogs without needing OS-level menu interaction.
async function sendMenuAction(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: any,
  action: string
): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return app.evaluate(({ BrowserWindow }: any, a: string) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return false
    win.webContents.send('menu:action', a)
    return true
  }, action)
}

// Regression for the P0 found in the QA review: opening ClassifyDialog
// against one scope, then triggering another classify scope while it's
// still mounted, used to leave the header showing the new scope but
// the body still tracking the old job. Fixed by keying the dialog on
// the scope at the AppLayout call site so it remounts.
test('ClassifyDialog remounts when scope changes mid-dialog', async () => {
  await mkdir(SCREENSHOTS, { recursive: true })

  const root = resolve(__dirname, '../..')
  const dataDir = await mkdtemp(resolve(tmpdir(), 'flist-workbench-classify-'))
  const app = await electron.launch({
    args: [resolve(root, 'out/main/main.js')],
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      FLIST_WORKBENCH_DATA_DIR: dataDir
    }
  })

  try {
    const window = await app.firstWindow()
    window.on('dialog', (d) => {
      void d.accept()
    })
    await expect(window.getByTestId('sidecar-status')).toContainText('ok')

    // Land in logs mode with a partner selected.
    await window.getByRole('tab', { name: 'Logs' }).click()
    const peopleList = window.getByTestId('partner-list-people')
    await expect(peopleList).toBeVisible({ timeout: 10_000 })
    const partners = peopleList.locator('li button.sb-item')
    await partners.first().click()
    await expect(window.getByTestId('log-body')).toBeVisible({ timeout: 15_000 })

    // First scope: Classify Current Conversation.
    expect(await sendMenuAction(app, 'classify-current')).toBe(true)
    const dialog = window.getByTestId('classify-dialog')
    await expect(dialog).toBeVisible()
    const subtitle = dialog.locator('.modal-subtitle')
    await expect(subtitle).not.toHaveText('All characters, all partners')

    // Second scope: Classify All Characters — sent while the dialog
    // is still up. Pre-fix the subtitle would update but the body
    // kept polling the first job; post-fix the component remounts
    // because we key it on scope.
    expect(await sendMenuAction(app, 'classify-all')).toBe(true)
    await expect(subtitle).toHaveText('All characters, all partners')

    // After remount the body either shows "Starting job…" briefly,
    // or progress text for the new scope. Either way it must NOT
    // still show "Working on:" referencing the original partner —
    // that line gates on the running state of the new job which
    // hasn't enumerated yet (total=0).
    const body = dialog.locator('.modal-body')
    await expect(body).not.toContainText(/Working on: .+with /, { timeout: 5_000 })

    await window.screenshot({
      path: resolve(SCREENSHOTS, 'classify-dialog-remounts.png')
    })
  } finally {
    await app.close()
  }
})
