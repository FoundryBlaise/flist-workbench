import { test, expect } from '@playwright/test'
import { join } from 'node:path'
import { launchApp, menuAction } from './launch'

test('Settings saves a new F-Chat folder and refreshes characters', async () => {
  // FCHAT_DATA_DIR unset, so the Settings value drives the folder.
  const { app, window, appData, fchatDir } = await launchApp({ pinFchatDir: false })
  try {
    const picker = window.getByTestId('char-picker')
    await expect(picker).toContainText('0 from logs')

    await menuAction(app, 'settings')
    const input = window.getByTestId('settings-fchat-dir-input')
    await expect(input).toBeFocused({ timeout: 2_000 })
    // With nothing saved the app falls back to F-Chat's default
    // folder, which the launch points into an empty temp APPDATA.
    const current = window.locator('.settings-meta code')
    await expect(current).toHaveText(join(appData, 'fchat', 'data'))

    // The folder picker is OS-native; bypass it by typing the path.
    await input.fill(fchatDir)
    await window.getByTestId('settings-save').click()
    await expect(current).toHaveText(fchatDir)
    await window.screenshot({ path: test.info().outputPath('settings-modal.png') })

    // The fixture folder holds two characters.
    await expect(picker).toContainText('2 from logs')
  } finally {
    await app.close()
  }
})
