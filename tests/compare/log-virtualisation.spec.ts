import { test, expect, _electron as electron } from '@playwright/test'
import { resolve } from 'node:path'

// Regression test for the UX-tester's MAJOR finding: opening the
// 4.9 MB #german ooc partner used to freeze the UI for 30+ seconds
// while React mounted ~82k message rows. With Virtuoso windowing,
// only the visible slice should mount and the open-channel time
// should be a small fraction of that.
//
// Also exercises the BLOCKER fix (search actually filters) and the
// MAJOR fix (search empty-state messaging) on real data.
test('huge channel opens quickly and search filters', async () => {
  const root = resolve(__dirname, '../..')
  const app = await electron.launch({
    args: [resolve(root, 'out/main/main.js')],
    cwd: root,
    env: { ...process.env, NODE_ENV: 'test' }
  })
  try {
    const w = await app.firstWindow()
    await expect(w.getByTestId('sidecar-status')).toContainText('ok')

    // Switch active character to Azure Viper so #german ooc shows up.
    await w.getByTestId('char-picker').locator('button.char-picker').click()
    await w.locator('.char-picker-menu button', { hasText: 'Azure Viper' }).click()

    await w.getByRole('tab', { name: 'Logs' }).click()
    const partnerList = w.getByTestId('partner-list')
    await expect(partnerList).toBeVisible({ timeout: 10_000 })

    const start = Date.now()
    await partnerList.locator('li button .label', { hasText: '#german ooc' }).first().click()
    await expect(w.getByTestId('log-body')).toBeVisible({ timeout: 10_000 })
    await expect(
      w.locator('.log-pill').filter({ hasText: /^IC \d/ })
    ).toBeVisible({ timeout: 10_000 })
    const elapsed = Date.now() - start
    console.log('open #german ooc took', elapsed, 'ms')
    // Used to be ~30s; current run lands well under 3s on the
    // dev container. Generous 5s budget so this stays useful as a
    // regression marker without flaking on slow CI.
    expect(elapsed).toBeLessThan(5_000)

    // Only a small window of message rows should be in the DOM, NOT
    // 82k. We use the visible range plus Virtuoso's overscan; anything
    // under a couple hundred is fine.
    const rowCount = await w.locator('.log-msg').count()
    console.log('rows in DOM after open:', rowCount)
    expect(rowCount).toBeLessThan(300)

    // Search filters to matches.
    await w.getByTestId('log-search').fill('xyzqqqq-impossible-string')
    await expect(w.locator('.pane-body-placeholder')).toContainText(
      'No messages match'
    )
    await w.getByTestId('log-search').fill('')
    // List comes back.
    await expect(w.locator('.log-msg').first()).toBeVisible()
  } finally {
    await app.close()
  }
})
