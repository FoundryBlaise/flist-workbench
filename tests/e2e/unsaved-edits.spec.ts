import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { seedCharacter, withApp } from './launch'

// An edit the autosave has not sent yet (it waits for a pause in
// typing) still reaches the Workbench when the window reloads, closes
// or the app quits: main asks the page to save before it goes away.

const ID = '4242'
const NAME = 'Cobalt Wren'
const BEFORE = 'Before the edit.'
const TYPED = ' Typed just now.'

/** Picks the character in the sidebar and waits for its description. */
async function openCharacter(window: Page): Promise<void> {
  await window.getByTestId('char-picker').getByRole('button').first().click()
  await window.locator('.char-picker-row-pick', { hasText: NAME }).click()
  await expect(window.locator('.cm-content')).toContainText(BEFORE)
}

/** Types at the end of the description; the autosave is still waiting. */
async function typeAnEdit(window: Page): Promise<void> {
  await window.locator('.cm-content').click()
  await window.keyboard.press('Control+End')
  await window.keyboard.type(TYPED)
}

/** The description the editor shows. */
function description(window: Page): Promise<string> {
  return window.locator('.cm-content').innerText()
}

/**
 * Clicks an item of the app's menu the way the user's click (or its
 * accelerator) does, with the app window as the focused window.
 * `match` is the item's role or label.
 */
async function clickMenuItem(app: ElectronApplication, match: string): Promise<void> {
  await app.evaluate(({ Menu, BrowserWindow }, m) => {
    type Item = Electron.MenuItem
    const find = (items: Item[]): Item | undefined => {
      for (const item of items) {
        if (item.role?.toLowerCase() === m.toLowerCase() || item.label === m) return item
        const inner = item.submenu && find(item.submenu.items)
        if (inner) return inner
      }
      return undefined
    }
    const item = find(Menu.getApplicationMenu()?.items ?? [])
    if (!item) throw new Error(`no menu item ${m}`)
    const win = BrowserWindow.getAllWindows()[0]
    // Off this call's stack: quitting ends the process under it.
    setTimeout(() => item.click(undefined, win, win?.webContents), 0)
  }, match)
}

/** What the description reads in a fresh start of the app on `dataDir`. */
async function descriptionAfterRestart(dataDir: string): Promise<string> {
  let text = ''
  await withApp(
    async ({ window }) => {
      await openCharacter(window)
      text = await description(window)
    },
    { dataDir }
  )
  return text
}

test('an unsaved edit survives View → Reload', async () => {
  const dataDir = await seedCharacter(ID, NAME, BEFORE)
  await withApp(
    async ({ app, window }) => {
      await openCharacter(window)
      await typeAnEdit(window)
      const reloaded = window.waitForEvent('load')
      await clickMenuItem(app, 'Reload')
      await reloaded
      // The reloaded page opens the sign-in again, as every start does.
      const signIn = window.locator('.flist-signin-modal')
      await expect(signIn).toBeVisible()
      await signIn.getByRole('button', { name: 'Close' }).click()
      await openCharacter(window)
      expect(await description(window)).toBe(BEFORE + TYPED)
    },
    { dataDir }
  )
})

test('an unsaved edit survives closing the window', async () => {
  const dataDir = await seedCharacter(ID, NAME, BEFORE)
  await withApp(
    async ({ app, window }) => {
      await openCharacter(window)
      await typeAnEdit(window)
      const closed = app.waitForEvent('close')
      // Closed the way the window's close button closes it.
      await (await app.browserWindow(window)).evaluate((w) => void setTimeout(() => w.close(), 0))
      await closed
    },
    { dataDir }
  )
  expect(await descriptionAfterRestart(dataDir)).toBe(BEFORE + TYPED)
})

test('an unsaved edit survives quitting from the menu', async () => {
  const dataDir = await seedCharacter(ID, NAME, BEFORE)
  await withApp(
    async ({ app, window }) => {
      await openCharacter(window)
      await typeAnEdit(window)
      const closed = app.waitForEvent('close')
      await clickMenuItem(app, 'quit')
      await closed
    },
    { dataDir }
  )
  expect(await descriptionAfterRestart(dataDir)).toBe(BEFORE + TYPED)
})

test('a page that never finishes saving does not keep the window open', async () => {
  await withApp(async ({ app, window }) => {
    // The page answers main's request with a save that never ends.
    await window.evaluate(() => {
      type Bridge = { onSaveEditsRequest?: (saver: () => Promise<void>) => void }
      ;(globalThis as { workbench?: Bridge }).workbench?.onSaveEditsRequest?.(() => new Promise<void>(() => undefined))
    })
    const closed = app.waitForEvent('close')
    const started = Date.now()
    await (await app.browserWindow(window)).evaluate((w) => void setTimeout(() => w.close(), 0))
    await closed
    // Main waits a few seconds, then closes anyway.
    expect(Date.now() - started).toBeLessThan(10_000)
  })
})
