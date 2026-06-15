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

// Screenshot harness for the new full-width tabs strip + BBCode toolbar
// layout, the Description-only view-mode toggle, and the eicon picker.
test('full-width tabs + toolbar, view-mode toggle, eicon picker', async () => {
  await mkdir(ARTIFACT_OUT, { recursive: true })
  await mkdir(SHARED_OUT, { recursive: true })

  const userData = await mkdtemp(join(tmpdir(), 'flist-workbench-view-modes-ux-'))
  execSync(`uv run --quiet python ${resolve(__dirname, 'seed-view-modes-archive.py')}`, {
    cwd: resolve(ROOT, 'sidecar'),
    env: { ...process.env, FLIST_WORKBENCH_DATA_DIR: userData },
    stdio: 'inherit'
  })

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
  await window.waitForLoadState('domcontentloaded')
  await window.waitForTimeout(2500)

  // First launch auto-opens the SignIn modal with no saved creds.
  await window.keyboard.press('Escape')
  await window.waitForTimeout(300)

  const dualShot = async (name: string) => {
    await window.screenshot({ path: resolve(ARTIFACT_OUT, `${name}.png`) })
    await window.screenshot({ path: resolve(SHARED_OUT, `${name}.png`) })
  }

  // Pick the seeded character.
  const picker = window.getByTestId('char-picker')
  await expect(picker).toBeVisible({ timeout: 10_000 })
  await picker.locator('button').first().click()
  await window.waitForTimeout(300)
  await window
    .getByRole('button', { name: /Test Sample Character/i })
    .first()
    .click()
  await window.waitForTimeout(800)

  // Materialise My edits if it's still on the live snapshot.
  const workingPick = window.getByTestId('flist-zone-working-pick')
  if (await workingPick.isVisible().catch(() => false)) {
    await workingPick.click()
    await window.waitForTimeout(800)
  }

  // Sanity: the tabs strip + toolbar + view-mode toggle exist.
  await expect(window.getByTestId('editor-tabs-bar')).toBeVisible()
  await expect(window.getByTestId('editor-view-mode')).toBeVisible()

  // Drive the view-mode via the toggle's onClick. force:true clicks
  // are flaky on a partially-laid-out CodeMirror, and JS-driven onClick
  // is the same React handler the user invokes — so this is a fair
  // simulation, not a shortcut around the UI.
  const setViewMode = (mode: 'split' | 'preview' | 'code') =>
    window.evaluate((m) => {
      const btn = document.querySelector<HTMLButtonElement>(
        `[data-testid="view-mode-${m}"]`
      )
      btn?.click()
    }, mode)

  await setViewMode('split')
  await window.waitForTimeout(400)
  await dualShot('view-modes-description-split')

  await setViewMode('code')
  await window.waitForTimeout(400)
  await dualShot('view-modes-description-code')

  await setViewMode('preview')
  await window.waitForTimeout(400)
  await dualShot('view-modes-description-preview')

  // Back to split for the remaining captures.
  await setViewMode('split')
  await window.waitForTimeout(400)

  // Eicon picker. The Toolbar's onClick is what really matters; drive
  // it the same way as the view-mode toggle for the same reason.
  await window.evaluate(() => {
    const btn = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.editor-toolbar .tool')
    ).find((b) => b.title.startsWith('Emote icon'))
    btn?.click()
  })
  await window.waitForTimeout(800)
  await expect(window.getByTestId('toolbar-eicon-popover')).toBeVisible({
    timeout: 5000
  })
  await dualShot('view-modes-eicon-picker')

  await window.getByTestId('toolbar-eicon-search').fill('love')
  await window.waitForTimeout(500)
  await dualShot('view-modes-eicon-picker-search')

  await app.close()
})
