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

const SIDEBAR_WIDTH = 280

async function dualShot(window: Awaited<ReturnType<ElectronApplication['firstWindow']>>, name: string) {
  await window.screenshot({ path: resolve(ARTIFACT_OUT, `${name}.png`) })
  await window.screenshot({ path: resolve(SHARED_OUT, `${name}.png`) })

  const sidebar = window.locator('aside.sidebar').first()
  if (await sidebar.isVisible().catch(() => false)) {
    const box = await sidebar.boundingBox()
    if (box) {
      const clip = {
        x: Math.max(0, box.x - 1),
        y: Math.max(0, box.y - 1),
        width: Math.min(SIDEBAR_WIDTH + 2, box.width + 2),
        height: box.height + 2,
      }
      await window.screenshot({
        path: resolve(SHARED_OUT, `${name}__sidebar.png`),
        clip,
      })
    }
  }
}

test('Tier 7 sidebar — sets / snapshots / backups', async () => {
  await mkdir(ARTIFACT_OUT, { recursive: true })
  await mkdir(SHARED_OUT, { recursive: true })

  const userData = await mkdtemp(join(tmpdir(), 'flist-workbench-tier7-ux-'))
  execSync(
    `uv run --quiet python ${resolve(__dirname, 'seed-sets-archive.py')}`,
    {
      cwd: resolve(ROOT, 'sidecar'),
      env: { ...process.env, FLIST_WORKBENCH_DATA_DIR: userData },
      stdio: 'inherit'
    }
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
  await window.waitForLoadState('domcontentloaded')
  await window.waitForTimeout(2500)

  // ---- 1. No character signed in ----
  await dualShot(window, 'tier7-no-character')

  // ---- Pick the seeded character ----
  const picker = window.getByTestId('char-picker')
  await expect(picker).toBeVisible({ timeout: 10_000 })
  await picker.locator('button').first().click()
  await window.waitForTimeout(300)
  await window
    .getByRole('button', { name: /Lady Amber Rotas/i })
    .first()
    .click()
  await window.waitForTimeout(1200)

  // ---- 2. Character loaded — accordion defaults ----
  await dualShot(window, 'tier7-character-loaded-defaults')

  // ---- 3. Working set expanded (non-active) ----
  // Try clicking the second set row's chevron / activate
  const setChevs = window.locator('.t7-set-chev')
  if ((await setChevs.count()) >= 2) {
    await setChevs.nth(1).click()
    await window.waitForTimeout(400)
    await dualShot(window, 'tier7-working-set-expanded')
  }

  // ---- 4. Backups list (mid-scroll) ----
  const backupsBody = window.getByTestId('accordion-section-body-backups')
  if (await backupsBody.isVisible().catch(() => false)) {
    await backupsBody.evaluate((el) => {
      ;(el as HTMLElement).scrollTop = 20
    })
    await window.waitForTimeout(200)
    await dualShot(window, 'tier7-backups-list')
  }

  // ---- 5. Right-click on a set row ----
  const firstSetRow = window.locator('.t7-set-row').first()
  if (await firstSetRow.isVisible().catch(() => false)) {
    await firstSetRow.click({ button: 'right' })
    await window.waitForTimeout(300)
    await dualShot(window, 'tier7-right-click-set')
    await window.keyboard.press('Escape')
    await window.waitForTimeout(200)
  }

  // ---- 6. Right-click on a snapshot row ----
  const firstSnap = window.locator('.t7-snapshot-row').first()
  if (await firstSnap.isVisible().catch(() => false)) {
    await firstSnap.click({ button: 'right' })
    await window.waitForTimeout(300)
    await dualShot(window, 'tier7-right-click-snapshot')
    await window.keyboard.press('Escape')
    await window.waitForTimeout(200)
  }

  // ---- 7. Right-click on a backup row ----
  const firstBackup = window.locator('.t7-backup-row').first()
  if (await firstBackup.isVisible().catch(() => false)) {
    await firstBackup.click({ button: 'right' })
    await window.waitForTimeout(300)
    await dualShot(window, 'tier7-right-click-backup')
    await window.keyboard.press('Escape')
    await window.waitForTimeout(200)
  }

  // ---- 8. New-set dropdown open ----
  const newSetBtn = window.getByTestId('t7-new-set-btn')
  if (await newSetBtn.isVisible().catch(() => false)) {
    await newSetBtn.click()
    await window.waitForTimeout(300)
    await dualShot(window, 'tier7-new-set-menu')
    await window.keyboard.press('Escape')
    await window.waitForTimeout(200)
  }

  // ---- 9. Make-backup modal ----
  const makeBackupBtn = window.getByTestId('t7-backups-make')
  if (await makeBackupBtn.isVisible().catch(() => false)) {
    await makeBackupBtn.click()
    await window.waitForTimeout(300)
    await dualShot(window, 'tier7-make-backup-modal')
    await window.keyboard.press('Escape')
    await window.waitForTimeout(200)
  }

  await app.close()
})
