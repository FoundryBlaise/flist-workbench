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

function listCharacterIds(userData: string): string[] {
  const charsRoot = join(userData, 'characters')
  if (!existsSync(charsRoot)) return []
  return readdirSync(charsRoot).filter((n) =>
    existsSync(join(charsRoot, n, 'live.json'))
  )
}

test('Auto-refresh on sign-in pulls every roster character in the background', async () => {
  const creds = loadCreds()
  test.skip(!creds, 'No /workspace/.flist-test-creds — skipping live test.')

  await mkdir(ARTIFACT_OUT, { recursive: true })
  await mkdir(SHARED_OUT, { recursive: true })

  const userData = await mkdtemp(
    join(tmpdir(), 'flist-workbench-auto-refresh-')
  )
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
  // Auto-refresh is off by default; opt in so the sweep we're testing
  // actually runs. With a fresh userData every character's last-pull
  // time is null → infinitely-old → 24h threshold is satisfied for all.
  await window.evaluate(() => {
    try {
      window.localStorage.clear()
      window.localStorage.setItem('workbench.flistAutoRefreshEnabled', 'true')
      window.localStorage.setItem('workbench.flistAutoRefreshHours', '24')
    } catch {
      /* best-effort */
    }
  })
  await window.waitForTimeout(2200)

  const shot = async (name: string) => {
    await window.screenshot({ path: resolve(ARTIFACT_OUT, `${name}.png`) })
    await window.screenshot({ path: resolve(SHARED_OUT, `${name}.png`) })
  }

  // Fresh userData → no characters yet.
  expect(listCharacterIds(userData)).toEqual([])

  // ---- Sign in -----------------------------------------------------
  await window.getByTestId('char-picker').locator('button').first().click()
  await window.waitForTimeout(300)
  await window.getByTestId('char-picker-signin').click()
  await window.waitForTimeout(400)
  await window.getByTestId('flist-signin-account').fill(creds!.account)
  await window.getByTestId('flist-signin-password').fill(creds!.password)
  await window.getByTestId('flist-signin-submit').click()
  // Just a brief wait for sign-in to return; the auto-refresh fires
  // immediately after but runs in the background.
  await window.waitForTimeout(4000)
  await shot('arol-01-signed-in')

  // Wait for the auto-refresh to populate every account character's
  // local archive. With a 2-character account and ~1 req/s rate limit
  // for JSON + per-image CDN downloads, 120s is generous. We don't
  // know the roster size up front — open the picker briefly to read
  // the visible account-row count, then close it so the test isn't
  // blocked on UI interactions.
  await window.getByTestId('char-picker').locator('button').first().click()
  await window.waitForTimeout(400)
  // Only count account-character rows. The picker also surfaces
  // "Logs only" archived characters in a separate <ul> below the
  // account section; those don't trigger auto-refresh (no F-list
  // pull is possible without an id).
  const accountRows = await window
    .locator(
      '.char-picker-unified-list:not(.char-picker-unified-list-archive) .char-picker-row-pick'
    )
    .count()
  expect(accountRows).toBeGreaterThan(0)
  await window.keyboard.press('Escape')

  // Poll the on-disk state — auto-refresh writes live.json + populates
  // images/ as each per-character pull finishes. Cheap, no UI waits.
  const deadline = Date.now() + 180_000
  let lastSeen = 0
  while (Date.now() < deadline) {
    const ids = listCharacterIds(userData)
    if (ids.length !== lastSeen) {
      lastSeen = ids.length
      console.log(`[auto-refresh] live.json count: ${ids.length}/${accountRows}`)
    }
    if (ids.length >= accountRows) break
    await window.waitForTimeout(1500)
  }

  await shot('arol-02-after-auto-refresh')
  expect(listCharacterIds(userData).length).toBe(accountRows)

  await app.close()
})
