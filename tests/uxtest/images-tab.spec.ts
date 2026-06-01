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

// Drives a screenshot run of the Images tab + the gallery preview pane.
// Pre-seeds an archive with 24 synthetic varied-aspect PNGs (via the
// sidecar's character_archive helpers) so the tile-heap demonstrates
// multi-row wrap behaviour. Saves to tests/screenshots/ for the user.
test('images tab gallery preview + tile-heap + fullscreen', async () => {
  await mkdir(ARTIFACT_OUT, { recursive: true })
  await mkdir(SHARED_OUT, { recursive: true })

  const userData = await mkdtemp(join(tmpdir(), 'flist-workbench-images-ux-'))
  execSync(`uv run --quiet python ${resolve(__dirname, 'seed-images-archive.py')}`, {
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

  const dualShot = async (name: string) => {
    await window.screenshot({ path: resolve(ARTIFACT_OUT, `${name}.png`) })
    await window.screenshot({ path: resolve(SHARED_OUT, `${name}.png`) })
  }

  // --- Pick the seeded character ---
  const picker = window.getByTestId('char-picker')
  await expect(picker).toBeVisible({ timeout: 10_000 })
  await picker.locator('button').first().click()
  await window.waitForTimeout(300)
  // Click the row whose name matches our seeded character.
  await window
    .getByRole('button', { name: /Test Sample Character/i })
    .first()
    .click()
  await window.waitForTimeout(800)

  // --- Materialise working copy (My edits) ---
  // Try the FlistCharacterZone's working-pick button if it's visible.
  const workingPick = window.getByTestId('flist-zone-working-pick')
  if (await workingPick.isVisible().catch(() => false)) {
    await workingPick.click()
    await window.waitForTimeout(500)
  }

  // --- Click Images tab ---
  await window.getByRole('tab', { name: /^Images$/ }).click()
  await window.waitForTimeout(1200) // let thumbs load

  await dualShot('images-tab-overview')

  // --- Hover-zoom on a left-pane thumb ---
  // First gallery row's thumb in "On profile" — hovering should pop a
  // larger preview.
  const firstGalleryThumb = window
    .locator('.flist-images-gallery-item__thumb.flist-images-thumb-hover')
    .first()
  if (await firstGalleryThumb.isVisible().catch(() => false)) {
    await firstGalleryThumb.hover()
    await window.waitForTimeout(400)
    await dualShot('images-tab-hover-zoom')
  }

  // --- Fullscreen viewer on a right-pane tile ---
  const firstTile = window
    .locator('.flist-gallery-preview__tile-btn')
    .first()
  if (await firstTile.isVisible().catch(() => false)) {
    await firstTile.click()
    await window.waitForTimeout(500)
    await dualShot('images-tab-fullscreen')

    // Close fullscreen
    await window
      .getByTestId('flist-gallery-fullscreen-back')
      .click()
    await window.waitForTimeout(300)
  }

  await app.close()
})
