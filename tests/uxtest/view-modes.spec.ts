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

// Screenshot harness for the full-width tabs bar + Description tab
// view-mode toggle (Split / Code / Preview) + the eicon picker.
test('full-width tabs bar, view-mode toggle, and eicon picker', async () => {
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

  // First launch with no saved F-list credentials auto-opens the
  // SignInModal. Close it — we don't need a live session for these
  // screenshots (everything is driven from the pre-seeded archive).
  await window.keyboard.press('Escape')
  await window.waitForTimeout(300)

  const dualShot = async (name: string) => {
    await window.screenshot({ path: resolve(ARTIFACT_OUT, `${name}.png`) })
    await window.screenshot({ path: resolve(SHARED_OUT, `${name}.png`) })
  }

  // --- Pick the seeded character ---
  const picker = window.getByTestId('char-picker')
  await expect(picker).toBeVisible({ timeout: 10_000 })
  await picker.locator('button').first().click()
  await window.waitForTimeout(300)
  await window
    .getByRole('button', { name: /Test Sample Character/i })
    .first()
    .click()
  await window.waitForTimeout(800)

  // Materialise My edits if needed.
  const workingPick = window.getByTestId('flist-zone-working-pick')
  if (await workingPick.isVisible().catch(() => false)) {
    await workingPick.click()
    await window.waitForTimeout(600)
  }

  // Description tab is the default. Confirm tabs bar + view-mode toggle.
  await expect(window.getByTestId('editor-tabs-bar')).toBeVisible()
  await expect(window.getByTestId('editor-view-mode')).toBeVisible()

  const setViewMode = (mode: 'split' | 'preview' | 'code') =>
    window.evaluate((m) => {
      const btn = document.querySelector<HTMLButtonElement>(
        `[data-testid="view-mode-${m}"]`
      )
      btn?.click()
    }, mode)

  // --- Description tab: split / code / preview ---
  await setViewMode('split')
  await window.waitForTimeout(300)
  await dualShot('view-modes-description-split')

  await setViewMode('code')
  await window.waitForTimeout(300)
  await dualShot('view-modes-description-code')

  await setViewMode('preview')
  await window.waitForTimeout(300)
  await dualShot('view-modes-description-preview')

  // Back to split for the eicon picker.
  await setViewMode('split')
  await window.waitForTimeout(300)

  // --- Eicon picker ---
  // Open the popover by driving its trigger via JS — clicking through
  // CodeMirror's editable surface is flaky under Xvfb, but the button
  // is a regular React component so dispatching click() directly is
  // fine here.
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
