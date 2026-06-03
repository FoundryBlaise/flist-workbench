import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication
} from '@playwright/test'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
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

function countBackupFiles(userData: string): number {
  const charsRoot = join(userData, 'characters')
  if (!existsSync(charsRoot)) return 0
  let total = 0
  for (const id of readdirSync(charsRoot)) {
    const dir = join(charsRoot, id, 'backups')
    if (!existsSync(dir)) continue
    total += readdirSync(dir).filter((n) => n.endsWith('.json')).length
  }
  return total
}

test('Backup all — fresh sweep saves every character, second sweep dedups', async () => {
  const creds = loadCreds()
  test.skip(!creds, 'No /workspace/.flist-test-creds — skipping live test.')

  await mkdir(ARTIFACT_OUT, { recursive: true })
  await mkdir(SHARED_OUT, { recursive: true })

  const userData = await mkdtemp(join(tmpdir(), 'flist-workbench-backup-all-'))
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
  // Clear leftover localStorage from previous test runs (Electron's own
  // user-data dir persists across spec files). Otherwise the
  // `flist-last-character` key triggers an auto-pull on sign-in that
  // holds `pull_lock` while we try to start the sweep — banner sits at
  // (0/N) waiting for ~60s of image downloads to finish.
  await window.evaluate(() => {
    try {
      window.localStorage.clear()
    } catch {
      /* best-effort */
    }
  })
  await window.waitForTimeout(2200)

  const shot = async (name: string) => {
    await window.screenshot({ path: resolve(ARTIFACT_OUT, `${name}.png`) })
    await window.screenshot({ path: resolve(SHARED_OUT, `${name}.png`) })
  }

  // Trigger the Tools → Back up all menu item without going through
  // the native menu (Playwright can't drive native menus). The renderer
  // listens on `menu:action`; impersonating that channel exercises the
  // same code path as a real menu click.
  const triggerBackupAll = async () => {
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      win?.webContents.send('menu:action', 'backup-all')
    })
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
  await shot('bka-01-signed-in')

  // Capture roster size so the "Saved N" assertion is creds-agnostic.
  // After sign-in the picker's account characters land in the store;
  // the F-list session zone is the simplest read surface.
  await window.getByTestId('char-picker').locator('button').first().click()
  await window.waitForTimeout(400)
  const accountRowCount = await window
    .locator('.char-picker-row-pick')
    .count()
  expect(accountRowCount).toBeGreaterThan(0)
  // Close the picker before the banner renders so we screenshot the
  // banner cleanly.
  await window.keyboard.press('Escape')
  await window.waitForTimeout(400)

  // ---- First sweep — every character is new → all should be saved -
  // `countBackupFiles` measures *delta*, not absolute: a previous test
  // run's localStorage may have a last-character pointer that triggered
  // an auto-pull on sign-in, planting one stale backup. Tracking the
  // delta makes this assertion robust to that.
  const backupsBeforeFirst = countBackupFiles(userData)
  await triggerBackupAll()

  const banner = window.getByTestId('backup-all-banner')
  await expect(banner).toBeVisible({ timeout: 10_000 })
  await shot('bka-02-banner-running')

  // Sweep duration: ≤ ~5s per character thanks to the rate limiter +
  // F-list response time. 60s is a generous ceiling.
  await expect(banner).toContainText(/Back up all complete/, {
    timeout: 120_000
  })
  await shot('bka-03-banner-done')

  const doneText = (await banner.textContent()) ?? ''
  // First sweep: every roster character should be saved. Permit
  // 0 unchanged + 0 failed strictly. Roster might also be slightly
  // larger than the visible account rows (archived characters from
  // other sessions are filtered out by the picker but not the sweep);
  // sanity-check by counting backup files on disk vs the saved count
  // the banner reports.
  expect(doneText).toMatch(/Saved (\d+) character/)
  const savedMatch = doneText.match(/Saved (\d+) character/)
  const savedFirst = savedMatch ? Number(savedMatch[1]) : 0
  expect(savedFirst).toBeGreaterThan(0)
  expect(doneText).not.toMatch(/, [1-9]\d* failed/)

  // Backup files actually landed on disk — one .json per saved char.
  const backupCountAfterFirst = countBackupFiles(userData)
  expect(backupCountAfterFirst - backupsBeforeFirst).toBe(savedFirst)

  // The banner auto-clears after 6s. Wait for it to disappear so the
  // second sweep starts from a clean state.
  await expect(banner).toBeHidden({ timeout: 10_000 })
  await shot('bka-04-banner-cleared')

  // ---- "F-list edited" indicator after pulls landed ----------------
  await window.getByTestId('char-picker').locator('button').first().click()
  await window.waitForTimeout(400)
  await window.locator('.char-picker-row-pick').first().click()
  await window.waitForTimeout(2200)
  const fromFlistMeta = window
    .getByTestId('flist-zone-from-flist')
    .locator('.flist-zone-setrow-meta')
  await expect(fromFlistMeta).toContainText(/F-list edited/, {
    timeout: 5_000
  })
  await shot('bka-05-flist-edited-label')

  // ---- Second sweep — content unchanged, every char must dedup ----
  await triggerBackupAll()
  await expect(banner).toBeVisible({ timeout: 10_000 })
  await expect(banner).toContainText(/Back up all complete/, {
    timeout: 120_000
  })
  await shot('bka-06-banner-second-done')

  const secondText = (await banner.textContent()) ?? ''
  // The second sweep: zero new content => zero new saves; every
  // character counted as unchanged. Failed must stay at zero. (We
  // don't assert the exact unchanged count because a stale auto-pull
  // before the first sweep can shift it by one.)
  expect(secondText).toMatch(/Saved 0 character/)
  expect(secondText).toMatch(/\d+ unchanged/)
  expect(secondText).not.toMatch(/, [1-9]\d* failed/)

  // And the on-disk count didn't grow.
  expect(countBackupFiles(userData)).toBe(backupCountAfterFirst)

  await app.close()
})
