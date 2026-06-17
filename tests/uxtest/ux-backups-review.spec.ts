import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { execSync } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SHARED_OUT = resolve(__dirname, '../screenshots')
const ROOT = resolve(__dirname, '../..')

// UX review of the snippets-removal + Backups-section + Browse-backup
// viewer changes. Captures screenshots for spot-check.
test('backups section + browse-backup viewer UX', async () => {
  await mkdir(SHARED_OUT, { recursive: true })

  const userData = await mkdtemp(join(tmpdir(), 'flist-workbench-backups-ux-'))
  execSync(`uv run --quiet python ${resolve(__dirname, 'seed-backups-ux.py')}`, {
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

  const window: Page = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await window.waitForTimeout(2500)

  const shot = async (name: string) => {
    await window.screenshot({ path: resolve(SHARED_OUT, `ux-bkrev-${name}.png`), fullPage: false })
  }

  // Dismiss the sign-in modal that auto-opens when no saved creds.
  const signInClose = window.getByTestId('flist-signin-cancel').or(
    window.getByRole('button', { name: /^close$/i })
  )
  if (await signInClose.first().isVisible().catch(() => false)) {
    await signInClose.first().click()
    await window.waitForTimeout(400)
  } else {
    await window.keyboard.press('Escape')
    await window.waitForTimeout(400)
  }

  // 1. Initial state — no character selected. Check for snippets removal
  //    and the "no character" empty state for the Backups section.
  await shot('00-initial-no-character')

  // Dump the visible text once so we can scan for stale "Snippets" strings.
  const initialText = await window.locator('body').innerText()
  await writeFile(resolve(SHARED_OUT, 'ux-bkrev-initial-text.txt'), initialText)

  // 2. Pick the seeded character with a backup.
  const picker = window.getByTestId('char-picker')
  if (await picker.isVisible().catch(() => false)) {
    await picker.locator('button').first().click()
    await window.waitForTimeout(400)
  }
  // Try a row click — fall back to clicking the textual name.
  const charRow = window.getByRole('button', { name: /Sample Backed Up Char/i }).first()
  if (await charRow.isVisible().catch(() => false)) {
    await charRow.click()
  } else {
    await window.getByText(/Sample Backed Up Char/i).first().click()
  }
  await window.waitForTimeout(1200)
  await shot('01-character-with-backup-selected')

  const afterPickText = await window.locator('body').innerText()
  await writeFile(resolve(SHARED_OUT, 'ux-bkrev-after-pick-text.txt'), afterPickText)

  // 3. Right-click on the backup row to surface the context menu.
  // We don't know the exact CSS class, so try a few selectors.
  const possibleBackupRow = window
    .locator(
      'text=/Today \\d{2}:\\d{2}|Yesterday \\d{2}:\\d{2}|20\\d{2}-\\d{2}-\\d{2} \\d{2}:\\d{2}/'
    )
    .first()
  if (await possibleBackupRow.isVisible().catch(() => false)) {
    await possibleBackupRow.click({ button: 'right' })
    await window.waitForTimeout(400)
    await shot('02-backup-rightclick-menu')

    // Esc dismisses.
    await window.keyboard.press('Escape')
    await window.waitForTimeout(300)
    await shot('03-after-esc-dismiss')

    // 4. Double-click to open Browse backup.
    await possibleBackupRow.dblclick()
    await window.waitForTimeout(1500)
    await shot('04-browse-backup-doubleclick')

    // 5. Cycle through the inner tabs if they exist.
    for (const tabName of ['Description', 'Profile fields', 'Kinks', 'Images']) {
      const t = window.getByRole('tab', { name: new RegExp(`^${tabName}$`) }).first()
      if (await t.isVisible().catch(() => false)) {
        await t.click()
        await window.waitForTimeout(500)
        await shot(`05-browse-${tabName.toLowerCase().replace(/ /g, '-')}`)
      }
    }

    // 6. Look for "Back to working copy" button.
    const backBtn = window.getByRole('button', { name: /back to working copy/i }).first()
    if (await backBtn.isVisible().catch(() => false)) {
      await shot('06-before-back-to-working')
      await backBtn.click()
      await window.waitForTimeout(800)
      await shot('07-after-back-to-working')
    } else {
      await shot('06-no-back-button-found')
    }
  } else {
    await shot('02-no-backup-row-detected')
  }

  // 7. Switch to the empty-backups character — verify the empty state.
  if (await picker.isVisible().catch(() => false)) {
    await picker.locator('button').first().click()
    await window.waitForTimeout(400)
  }
  const emptyRow = window.getByRole('button', { name: /Sample Empty Char/i }).first()
  if (await emptyRow.isVisible().catch(() => false)) {
    await emptyRow.click()
  } else {
    await window.getByText(/Sample Empty Char/i).first().click()
  }
  await window.waitForTimeout(1200)
  await shot('08-empty-character-selected')

  const emptyText = await window.locator('body').innerText()
  await writeFile(resolve(SHARED_OUT, 'ux-bkrev-empty-text.txt'), emptyText)

  await app.close()
})
