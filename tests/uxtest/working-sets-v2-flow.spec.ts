import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication
} from '@playwright/test'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ARTIFACT_OUT = resolve(__dirname, 'artifacts')
const SHARED_OUT = resolve(__dirname, '../screenshots')
const ROOT = resolve(__dirname, '../..')
const SIDEBAR_WIDTH = 280

function loadCreds(): { account: string; password: string } | null {
  try {
    const raw = readFileSync('/workspace/.flist-test-creds', 'utf-8')
    const pairs: Record<string, string> = {}
    for (const line of raw.split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.+)$/)
      if (m) pairs[m[1]] = m[2].trim()
    }
    if (pairs.FLIST_TEST_ACCOUNT && pairs.FLIST_TEST_PASSWORD) {
      return {
        account: pairs.FLIST_TEST_ACCOUNT,
        password: pairs.FLIST_TEST_PASSWORD
      }
    }
  } catch {
    /* fallthrough */
  }
  return null
}

test('Working sets v2 — full flow against the real account', async () => {
  const creds = loadCreds()
  test.skip(!creds, 'No /workspace/.flist-test-creds — skipping live test.')

  await mkdir(ARTIFACT_OUT, { recursive: true })
  await mkdir(SHARED_OUT, { recursive: true })

  const userData = await mkdtemp(join(tmpdir(), 'flist-workbench-ws2-flow-'))
  // Belt + suspenders: ensure no leftover archive data leaks in. The
  // mkdtemp already gives us a fresh dir, but documenting the intent
  // explicitly per the user's "delete local data" instruction.
  await rm(userData, { recursive: true, force: true })
  await mkdir(userData, { recursive: true })

  const app: ElectronApplication = await electron.launch({
    args: [resolve(ROOT, 'out/main/main.js')],
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      FLIST_WORKBENCH_DATA_DIR: userData
    }
  })
  const window = await app.firstWindow()
  window.on('console', (msg) => {
    if (msg.type() === 'error') console.log('[renderer-error]', msg.text())
  })
  window.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await window.waitForLoadState('domcontentloaded')
  await window.waitForTimeout(2200)

  const shot = async (name: string) => {
    await window.screenshot({ path: resolve(ARTIFACT_OUT, `${name}.png`) })
    await window.screenshot({ path: resolve(SHARED_OUT, `${name}.png`) })
    const sidebar = window.locator('aside.sidebar').first()
    if (await sidebar.isVisible().catch(() => false)) {
      const box = await sidebar.boundingBox()
      if (box) {
        await window.screenshot({
          path: resolve(SHARED_OUT, `${name}__sidebar.png`),
          clip: {
            x: Math.max(0, box.x - 1),
            y: Math.max(0, box.y - 1),
            width: Math.min(SIDEBAR_WIDTH + 2, box.width + 2),
            height: box.height + 2
          }
        })
      }
    }
  }

  // ---- Sign in ----
  await window.getByTestId('char-picker').locator('button').first().click()
  await window.waitForTimeout(300)
  await window.getByTestId('char-picker-signin').click()
  await window.waitForTimeout(400)
  await shot('wsf-01-signin-modal')
  await window.getByTestId('flist-signin-account').fill(creds!.account)
  await window.getByTestId('flist-signin-password').fill(creds!.password)
  await window.getByTestId('flist-signin-submit').click()
  // Sign-in then roster load + auto-restore last char can take a moment
  // against the live F-list API.
  await window.waitForTimeout(6000)
  await shot('wsf-02-signed-in')

  // ---- Pick a character from the F-list account ----
  await window.getByTestId('char-picker').locator('button').first().click()
  await window.waitForTimeout(400)
  // Picker rows don't have a dedicated testid; the account-character
  // rows come first under an "On F-list" heading, so `.first()` is the
  // first account character.
  await window.locator('.char-picker-row-pick').first().click()
  await window.waitForTimeout(2200) // let archive load
  await shot('wsf-03-character-picked')

  // ---- Pull so live.json exists ----
  const pullBtn = window.locator('.flist-zone-pull')
  if (await pullBtn.isVisible().catch(() => false)) {
    await pullBtn.click()
    // Pull can take a while for images; wait for the chip's "Refresh"
    // label to come back (which means the pull finished).
    await expect(pullBtn).toContainText(/Refresh/, { timeout: 60_000 })
  }
  await window.waitForTimeout(1200)
  await shot('wsf-04-after-pull')

  // ---- 1. From F-list shows the editor in read-only mode ----
  await window.getByTestId('flist-zone-from-flist').click()
  await window.waitForTimeout(800)
  await shot('wsf-05-from-flist-active')
  // The editor must show the read-only pill.
  await expect(window.locator('.doc-readonly-pill').first()).toBeVisible({
    timeout: 5_000
  })

  // ---- 2. Create the first working set ----
  await window.getByTestId('flist-zone-newset').click()
  await window.waitForTimeout(300)
  await shot('wsf-06-create-dialog')
  await window.getByTestId('ws-name-confirm').click()
  await window.waitForTimeout(1200)
  await shot('wsf-07-set1-active')

  // ---- 3. Capture the editor content for set 1 (the seeded live BBCode)
  // The editor is read-only when viewing From F-list, so the selector
  // can't require contenteditable="true". `.cm-content` is the CodeMirror
  // text container in both modes.
  const editorTextarea = window.locator('.cm-content').first()
  const set1OriginalContent = (await editorTextarea.textContent()) ?? ''
  expect(set1OriginalContent.length).toBeGreaterThan(0)

  // ---- 4. Delete all BBCode from set 1 (select-all + delete) ----
  await editorTextarea.click()
  await window.keyboard.press(
    process.platform === 'darwin' ? 'Meta+A' : 'Control+A'
  )
  await window.keyboard.press('Delete')
  // Wait for autosave debounce + PUT.
  await window.waitForTimeout(1500)
  await shot('wsf-08-set1-emptied')
  const set1EmptiedContent = (await editorTextarea.textContent()) ?? ''
  expect(set1EmptiedContent.trim().length).toBe(0)

  // ---- 5. Switch back to From F-list — content must still be the
  //         original live profile (read-only).
  await window.getByTestId('flist-zone-from-flist').click()
  await window.waitForTimeout(1000)
  await shot('wsf-09-from-flist-still-intact')
  const fromFlistContent = (await editorTextarea.textContent()) ?? ''
  expect(fromFlistContent.length).toBeGreaterThan(0)
  // It should match the original we captured before the emptying.
  expect(fromFlistContent).toBe(set1OriginalContent)

  // ---- 6. Create a second working set (seeded from live, NOT from set 1) ----
  await window.getByTestId('flist-zone-newset').click()
  await window.waitForTimeout(300)
  await window.getByTestId('ws-name-confirm').click()
  await window.waitForTimeout(1500)
  await shot('wsf-10-set2-active')
  const set2InitialContent = (await editorTextarea.textContent()) ?? ''
  expect(set2InitialContent).toBe(set1OriginalContent)

  // ---- 7. Swap to set 1 — must still be empty ----
  const setRows = window.locator('[data-testid^="flist-zone-setrow-"]')
  // Sets sort newest-updated-first; set 1 was edited most recently so
  // it should be at the top. Set 2 was just created so it's also
  // recent — order is "set 2, set 1" by createdAt fallback.
  // Use the row whose label says "Working set 1" explicitly.
  await window
    .locator('.flist-zone-setrow-name', { hasText: /^Working set 1$/ })
    .click()
  await window.waitForTimeout(1200)
  await shot('wsf-11-back-on-set1-empty')
  const set1AfterRoundtrip = (await editorTextarea.textContent()) ?? ''
  expect(set1AfterRoundtrip.trim().length).toBe(0)

  // ---- 8. Swap back to set 2 — must still have BBCode ----
  await window
    .locator('.flist-zone-setrow-name', { hasText: /^Working set 2$/ })
    .click()
  await window.waitForTimeout(1200)
  await shot('wsf-12-back-on-set2-intact')
  const set2AfterRoundtrip = (await editorTextarea.textContent()) ?? ''
  expect(set2AfterRoundtrip).toBe(set1OriginalContent)

  void setRows // silence the unused-locator lint if we drop the helper.
  await app.close()
})
