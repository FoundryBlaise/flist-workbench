import { test, expect } from '@playwright/test'
import { join } from 'node:path'
import { menuAction, withApp } from './launch'

test('Settings saves a new F-Chat folder and refreshes characters', async () => {
  // FCHAT_DATA_DIR unset, so the Settings value drives the folder.
  await withApp(
    async ({ app, window, appData, fchatDir }) => {
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

      // The fixture folder holds two characters.
      await expect(picker).toContainText('2 from logs')
    },
    { pinFchatDir: false }
  )
})

test('Settings → MCP turns Log text on in one click, and the Logs endpoint lists more tools', async () => {
  await withApp(async ({ app, window }) => {
    await menuAction(app, 'settings')
    await window.getByTestId('settings-rail-mcp').click()

    const state = window.getByTestId('settings-mcp-log-text-state')
    const logsTools = window.getByTestId('settings-mcp-tools-logs')
    await expect(state).toHaveText('Off')
    await expect(logsTools).toContainText(/^\d+ tools\./)
    const before = parseInt((await logsTools.textContent()) ?? '', 10)

    await window.getByTestId('settings-mcp-log-text-toggle').click()

    await expect(state).toHaveText('On')
    // Reading, searching, semantic search and messages to label.
    await expect(logsTools).toContainText(`${before + 4} tools.`)
  })
})
