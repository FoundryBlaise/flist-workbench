import { test, expect, _electron as electron } from '@playwright/test'
import { resolve } from 'node:path'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'

test('Settings modal saves a new FCHAT_DATA_DIR and refreshes characters', async () => {
  const root = resolve(__dirname, '../..')
  const dataDir = await mkdtemp(resolve(tmpdir(), 'flist-wb-settings-'))
  const altFchat = await mkdtemp(resolve(tmpdir(), 'flist-wb-alt-fchat-'))
  // Make the alt look like a real F-Chat data dir with one character.
  await mkdir(resolve(altFchat, 'TestChar', 'logs'), { recursive: true })

  const app = await electron.launch({
    args: [resolve(root, 'out/main/main.js')],
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      FLIST_WORKBENCH_DATA_DIR: dataDir,
      // Clear any pinned override so the settings DB drives the path.
      FCHAT_DATA_DIR: ''
    }
  })

  try {
    const window = await app.firstWindow()
    window.on('dialog', (d) => void d.accept())
    await expect(window.getByTestId('sidecar-status')).toContainText('ok')

    await window.getByTestId('settings-open').click()
    const input = window.getByTestId('settings-fchat-dir-input')
    await expect(input).toBeVisible()
    await expect(input).toBeFocused({ timeout: 2_000 })

    // The folder picker is OS-native; bypass it by typing the path.
    await input.fill(altFchat)
    await window.getByTestId('settings-save').click()

    // Settings round-tripped: the displayed value updates.
    await expect(window.locator('.settings-meta code')).toContainText(altFchat, {
      timeout: 5_000
    })
    await window.screenshot({ path: resolve(__dirname, '../screenshots/settings-modal.png') })
  } finally {
    await app.close()
  }
})
