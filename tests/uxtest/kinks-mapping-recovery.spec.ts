import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication
} from '@playwright/test'
import { execSync } from 'node:child_process'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ARTIFACT_OUT = resolve(__dirname, 'artifacts')
const SHARED_OUT = resolve(__dirname, '../screenshots')
const ROOT = resolve(__dirname, '../..')
const SEED_SCRIPT = resolve(__dirname, 'seed-kinks-archive.py')

// Hermetic regression test for the "buckets render only customs even
// though every standard kink is assigned" symptom that surfaced in
// the field. Pre-seeds an on-disk archive + mapping-list cache so the
// sidecar can serve everything without an F-list round-trip — no
// sign-in, no live network.
//
// What it verifies:
//   1. /flist/mapping-list returns the seeded kinks (sidecar plumbing)
//   2. KinksPane mounts with mapping AND working.json both available
//   3. Standard-kink rows appear in the bucket columns (>= 8 visible
//      across Fave/Yes/Maybe/No), proving buildUnifiedKinks merged
//      mapping + working.kinks correctly.
//
// If this ever drops to 0 it's the same class of regression as the
// user-reported "Every standard kink is assigned" empty-bucket bug.
test('kinks buckets render standard rows when mapping + working both loaded', async () => {
  await mkdir(ARTIFACT_OUT, { recursive: true })
  await mkdir(SHARED_OUT, { recursive: true })

  const userData = await mkdtemp(
    join(tmpdir(), 'flist-workbench-kinks-bucket-')
  )

  // Seed via the sidecar's own python entry points so the on-disk
  // shape is exactly what a real pull would produce. Using uv's venv
  // python so character_archive's imports resolve.
  execSync(
    `cd ${resolve(ROOT, 'sidecar')} && FLIST_WORKBENCH_DATA_DIR=${userData} .venv/bin/python ${SEED_SCRIPT}`,
    { stdio: 'inherit' }
  )

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
  await window.evaluate(() => {
    try { window.localStorage.clear() } catch { /* */ }
  })
  await window.waitForTimeout(2500)

  const shot = async (name: string) => {
    await window.screenshot({ path: resolve(ARTIFACT_OUT, `${name}.png`) })
    await window.screenshot({ path: resolve(SHARED_OUT, `${name}.png`) })
  }

  // Sidecar smoke: mapping-list resolved from the seeded cache, no
  // network round-trip needed. This call must succeed without a
  // signed-in F-list session because the cache TTL window protects it.
  const mappingProbe = await window.evaluate(async () => {
    try {
      const r = await fetch('http://127.0.0.1:27384/flist/mapping-list')
      const j = await r.json()
      return {
        ok: r.ok,
        count: Array.isArray(j.kinks) ? j.kinks.length : -1,
        groups: Array.isArray(j.kink_groups) ? j.kink_groups.length : -1
      }
    } catch (e) {
      return { ok: false, count: -1, error: String(e) }
    }
  })
  console.log('[probe] mapping-list:', mappingProbe)
  expect(mappingProbe.ok).toBe(true)
  expect(mappingProbe.count).toBeGreaterThan(0)

  // The sign-in modal opens at startup whenever there are no saved
  // creds (AppLayout behaviour). Dismiss it — the test character is
  // already on disk so we don't need a live session.
  const signInClose = window.getByTestId('flist-signin-cancel').or(
    window.getByRole('button', { name: /close/i })
  )
  if (await signInClose.first().isVisible().catch(() => false)) {
    await signInClose.first().click()
    await window.waitForTimeout(400)
  } else {
    await window.keyboard.press('Escape')
    await window.waitForTimeout(400)
  }

  // The seeded character should appear in the unified picker under
  // "Logs only / archived" (no live F-list session, but an archive
  // exists on disk). Click into it.
  await window.getByTestId('char-picker').locator('button').first().click()
  await window.waitForTimeout(400)
  const charRow = window.getByText('Test Kinks Character').first()
  await charRow.click()
  await window.waitForTimeout(2500)
  await shot('kinks-bucket-01-character-picked')

  // Switch to the Kinks tab.
  const kinksTab = window.getByRole('tab', { name: /^Kinks/ }).first()
  await kinksTab.click()
  await window.waitForTimeout(2500)
  await shot('kinks-bucket-02-kinks-tab')

  // Probe the rendered tree. Each bucket column carries its own
  // childCount; sum of standard-kink rows across all four buckets
  // must exceed our seeded assignment count minus a safety margin.
  const treeProbe = await window.evaluate(() => {
    const pane = document.querySelector('[data-testid="kinks-pane"]') as HTMLElement | null
    if (!pane) return { hasPane: false }
    const cols = Array.from(pane.querySelectorAll('.kink-column'))
      .map((c) => ({
        bucket: c.className,
        rowCount: c.querySelectorAll('[data-kink-id]').length
      }))
    return { hasPane: true, cols, text: pane.innerText.slice(0, 300) }
  })
  console.log('[probe] kinks-pane:', JSON.stringify(treeProbe, null, 2))

  const totalRows = treeProbe.hasPane
    ? (treeProbe.cols || []).reduce((a: number, c) => a + c.rowCount, 0)
    : 0
  // Seeded 10 standards across the buckets. Expect at least 8 visible
  // (allowing for any DOM quirk where 1–2 rows might not match the
  // selector but the principle "buckets are populated" still holds).
  expect(totalRows).toBeGreaterThan(7)

  await app.close()
})
