import { test, expect } from '@playwright/test'
import { menuAction, withApp } from './launch'

// The fixture F-Chat folder (fixtures/build_fchat_dir.py) has DM Logs
// with Antiquill under both Azure Viper and Lady Amber Blaise, and an
// Antiquill line in a channel that must not count as a DM.
test('Find Contacts lists every character with a DM Log and opens it', async () => {
  await withApp(async ({ app, window }) => {
    // A fresh data folder has no Workbench, so there is no editor to
    // hold focus first; the modal must still take focus on its own.
    await menuAction(app, 'find-contacts')
    const input = window.getByTestId('find-contacts-input')
    await expect(input).toBeFocused({ timeout: 2_000 })

    // Real key events, so a global keydown handler that swallows
    // keystrokes would fail here.
    await input.pressSequentially('antiquill', { delay: 20 })
    await expect(input).toHaveValue('antiquill')
    await window.locator('.find-contacts-submit').click()

    const results = window.getByTestId('find-contacts-results')
    await expect(results).toContainText('2 of your characters have a DM log with Antiquill')
    const rows = results.locator('tbody tr')
    await expect(rows).toHaveCount(2)
    await expect(rows.nth(0)).toContainText('Azure Viper')
    await expect(rows.nth(1)).toContainText('Lady Amber Blaise')

    // Open lands on that DM Log, read through the real parser.
    await rows.nth(1).getByRole('button', { name: 'Open' }).click()
    await expect(window.getByTestId('log-body')).toContainText(
      'slides the torn page across the counter.'
    )
  })
})
