import { test, expect, _electron as electron } from '@playwright/test'
import { resolve } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'

test('Find Contacts modal accepts typing and returns DM results', async () => {
  const root = resolve(__dirname, '../..')
  const dataDir = await mkdtemp(resolve(tmpdir(), 'flist-wb-fc-'))
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
    window.on('dialog', (d) => void d.accept())

    await expect(window.getByTestId('sidecar-status')).toContainText('ok')

    // Reproduce the user's actual flow: click into the editor first
    // so CodeMirror has focus, THEN open Find Contacts. This is the
    // case that exposes the autoFocus race.
    await window.getByTestId('editor-cm').locator('.cm-content').click()
    await window.keyboard.type('hi')

    await window.getByTestId('find-contacts-open').click()

    const input = window.getByTestId('find-contacts-input')
    await expect(input).toBeVisible()
    await expect(input).toBeFocused({ timeout: 2_000 })

    // Use pressSequentially so each character goes through a real
    // key event — this is what the user actually does and what would
    // fail if some global keydown handler is swallowing keystrokes.
    await input.pressSequentially('Antifuxxs', { delay: 20 })
    await expect(input).toHaveValue('Antifuxxs')

    await window.locator('.find-contacts-submit').click()

    // Either we get a DM result table OR a "no DM logs" placeholder —
    // both prove the input round-tripped to the sidecar.
    await expect(window.getByTestId('find-contacts-results')).toBeVisible()
    await expect(
      window.getByTestId('find-contacts-results')
    ).not.toContainText('Searching…', { timeout: 30_000 })
  } finally {
    await app.close()
  }
})
