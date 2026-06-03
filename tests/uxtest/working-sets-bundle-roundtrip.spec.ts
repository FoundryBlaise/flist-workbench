import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication
} from '@playwright/test'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ARTIFACT_OUT = resolve(__dirname, 'artifacts')
const SHARED_OUT = resolve(__dirname, '../screenshots')
const ROOT = resolve(__dirname, '../..')

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

test('Working sets v2 — bundle export/import roundtrip', async () => {
  const creds = loadCreds()
  test.skip(!creds, 'No /workspace/.flist-test-creds — skipping live test.')

  await mkdir(ARTIFACT_OUT, { recursive: true })
  await mkdir(SHARED_OUT, { recursive: true })

  const userData = await mkdtemp(join(tmpdir(), 'flist-workbench-bundle-'))
  await rm(userData, { recursive: true, force: true })
  await mkdir(userData, { recursive: true })

  // Path the stubbed save dialog will return + the stubbed open dialog
  // will reuse. Lives in the same tmp dir as the user data so cleanup
  // is implicit.
  const exportPath = join(userData, 'roundtrip-bundle.zip')

  const app: ElectronApplication = await electron.launch({
    args: [resolve(ROOT, 'out/main/main.js')],
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      FLIST_WORKBENCH_DATA_DIR: userData
    }
  })

  // Replace Electron's native file dialogs with stubs that just return
  // our pre-picked tmp path. Native dialogs can't be driven from
  // Playwright; the goal here is to exercise the wire + state + render
  // path, not the OS dialog itself.
  await app.evaluate(({ dialog }, picked: string) => {
    type SaveDialogReturn = { canceled: boolean; filePath?: string }
    type OpenDialogReturn = { canceled: boolean; filePaths: string[] }
    // Both APIs accept either (window, options) or (options); the
    // sidecar/main only ever calls the (window, options) overload, but
    // we stub both arities defensively.
    const fakeSave = async (): Promise<SaveDialogReturn> => ({
      canceled: false,
      filePath: picked
    })
    const fakeOpen = async (): Promise<OpenDialogReturn> => ({
      canceled: false,
      filePaths: [picked]
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(dialog as any).showSaveDialog = fakeSave
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(dialog as any).showOpenDialog = fakeOpen
  }, exportPath)

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
  }

  // ---- Sign in -----------------------------------------------------
  await window.getByTestId('char-picker').locator('button').first().click()
  await window.waitForTimeout(300)
  await window.getByTestId('char-picker-signin').click()
  await window.waitForTimeout(400)
  await window.getByTestId('flist-signin-account').fill(creds!.account)
  await window.getByTestId('flist-signin-password').fill(creds!.password)
  await window.getByTestId('flist-signin-submit').click()
  await window.waitForTimeout(6000)
  await shot('wsb-01-signed-in')

  // ---- Pick a character + pull -------------------------------------
  await window.getByTestId('char-picker').locator('button').first().click()
  await window.waitForTimeout(400)
  await window.locator('.char-picker-row-pick').first().click()
  await window.waitForTimeout(2200)
  const pullBtn = window.locator('.flist-zone-pull')
  if (await pullBtn.isVisible().catch(() => false)) {
    await pullBtn.click()
    await expect(pullBtn).toContainText(/Refresh/, { timeout: 60_000 })
  }
  await window.waitForTimeout(1200)
  await shot('wsb-02-pulled')

  // ---- Create a working set so we have something to export ---------
  await window.getByTestId('flist-zone-newset').click()
  await window.waitForTimeout(300)
  await window.getByTestId('ws-name-confirm').click()
  await window.waitForTimeout(1500)
  await shot('wsb-03-set-created')

  // Capture the source set's editor content so we can assert the
  // imported set matches byte-for-byte.
  const editor = window.locator('.cm-content').first()
  const sourceContent = (await editor.textContent()) ?? ''
  expect(sourceContent.length).toBeGreaterThan(0)

  // ---- Export via right-click context menu -------------------------
  // The fresh set is the active one and lives at the top of the list.
  const firstSetRow = window
    .locator('[data-testid^="flist-zone-setrow-"]')
    .first()
  await firstSetRow.click({ button: 'right' })
  await window.waitForTimeout(250)
  await shot('wsb-04-ctx-menu')
  // Context menu items don't have a testid; click by label.
  await window.locator('li', { hasText: /^Export as ZIP…$/ }).first().click()
  // Save dialog stub returns immediately; sidecar fetch + writeFile
  // both round-trip via IPC. Give it a beat.
  await window.waitForTimeout(2000)

  // ---- Assert the bundle landed on disk + is a valid ZIP -----------
  expect(existsSync(exportPath)).toBe(true)
  const exportStat = statSync(exportPath)
  expect(exportStat.size).toBeGreaterThan(200) // manifest + payload alone
  const exportBytes = readFileSync(exportPath)
  // PK\x03\x04 = local file header magic.
  expect(exportBytes[0]).toBe(0x50)
  expect(exportBytes[1]).toBe(0x4b)
  expect(exportBytes[2]).toBe(0x03)
  expect(exportBytes[3]).toBe(0x04)
  await shot('wsb-05-after-export')

  // ---- Import via the Import… button -------------------------------
  // Stub remains in place; openFileDialog returns the same path.
  await window.getByTestId('flist-zone-import').click()
  // Import POST + new-set activation + payload reload all happen here.
  await window.waitForTimeout(3000)
  await shot('wsb-06-after-import')

  // Success banner appears with "Imported …" — pick it up before the
  // 6-second auto-clear kicks in.
  const importMsg = window.getByTestId('flist-zone-import-msg')
  await expect(importMsg).toBeVisible({ timeout: 5_000 })
  await expect(importMsg).toContainText(/^Imported "Imported set 1"/)

  // The new "Imported set 1" row must be present and active. Sets sort
  // newest-first so it should be the top row.
  const importedRow = window
    .locator('.flist-zone-setrow-name', { hasText: /^Imported set 1$/ })
    .first()
  await expect(importedRow).toBeVisible({ timeout: 3_000 })

  // The imported set is auto-activated by flistImportSet; editor
  // content must match the source set we exported from.
  const importedContent = (await editor.textContent()) ?? ''
  expect(importedContent).toBe(sourceContent)
  await shot('wsb-07-imported-set-active')

  await app.close()
})
