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

test('Working sets v2 — area 2 (character working area)', async () => {
  await mkdir(ARTIFACT_OUT, { recursive: true })
  await mkdir(SHARED_OUT, { recursive: true })

  const userData = await mkdtemp(join(tmpdir(), 'flist-workbench-ws2-'))
  execSync(
    `uv run --quiet python ${resolve(__dirname, 'seed-images-archive.py')}`,
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
  window.on('console', (msg) => {
    if (msg.type() === 'error') console.log('[renderer-error]', msg.text())
  })
  window.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await window.waitForLoadState('domcontentloaded')
  await window.waitForTimeout(2200)
  await window.screenshot({ path: resolve(ARTIFACT_OUT, 'ws2-debug-launch.png') })

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

  // Pick the seeded character so the FlistCharacterZone activates.
  const picker = window.getByTestId('char-picker')
  await expect(picker).toBeVisible({ timeout: 10_000 })
  await picker.locator('button').first().click()
  await window.waitForTimeout(300)
  await window
    .getByRole('button', { name: /Test Sample Character/i })
    .first()
    .click()
  await window.waitForTimeout(1200)

  // 1. Initial state — only From F-list, no working sets.
  await shot('ws2-initial')

  // 2. Open the create dialog.
  await window.getByTestId('flist-zone-newset').click()
  await window.waitForTimeout(250)
  await shot('ws2-create-dialog')

  // Confirm the default name.
  await window.getByTestId('ws-name-confirm').click()
  await window.waitForTimeout(800)
  await shot('ws2-one-set')

  // 3. Create a second set (default auto-numbers to "Working set 2").
  await window.getByTestId('flist-zone-newset').click()
  await window.waitForTimeout(200)
  await shot('ws2-second-dialog')
  await window.getByTestId('ws-name-confirm').click()
  await window.waitForTimeout(600)
  await shot('ws2-two-sets')

  // 4. Right-click the first set (Working set 1) for the context menu.
  const firstSetRow = window
    .locator('[data-testid^="flist-zone-setrow-"]')
    .first()
  await firstSetRow.click({ button: 'right' })
  await window.waitForTimeout(300)
  await shot('ws2-context-menu')

  // 5. Click Rename to surface the rename dialog.
  await window.getByRole('menuitem', { name: 'Rename…' }).click()
  await window.waitForTimeout(250)
  await shot('ws2-rename-dialog')
  await window.keyboard.press('Escape')
  await window.waitForTimeout(150)

  // 6. Right-click again and pick Delete to surface confirm.
  await firstSetRow.click({ button: 'right' })
  await window.waitForTimeout(200)
  await window.getByRole('menuitem', { name: 'Delete…' }).click()
  await window.waitForTimeout(250)
  await shot('ws2-delete-confirm')
  await window.keyboard.press('Escape')
  await window.waitForTimeout(150)

  // 7. Click "From F-list" so the read-only row becomes active.
  await window.getByTestId('flist-zone-from-flist').click()
  await window.waitForTimeout(500)
  await shot('ws2-from-flist-active')

  await app.close()
})
