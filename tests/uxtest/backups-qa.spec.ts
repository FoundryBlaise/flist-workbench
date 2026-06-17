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

const ARTIFACT_OUT = resolve(__dirname, 'artifacts')
const SHARED_OUT = resolve(__dirname, '../screenshots')
const ROOT = resolve(__dirname, '../..')

const SIDECAR = 'http://127.0.0.1:27384'

type Report = Record<string, { status: 'pass' | 'fail' | 'blocked'; note: string }>
const report: Report = {}

const setStatus = (
  key: string,
  status: 'pass' | 'fail' | 'blocked',
  note: string
) => {
  report[key] = { status, note }
  // eslint-disable-next-line no-console
  console.log(`QA[${status.toUpperCase()}] ${key}: ${note}`)
}

const dualShot = async (window: Page, name: string) => {
  await window.screenshot({ path: resolve(ARTIFACT_OUT, `${name}.png`) })
  await window.screenshot({ path: resolve(SHARED_OUT, `${name}.png`) })
}

const fetchStatus = async (window: Page, path: string) => {
  return await window.evaluate(async (url) => {
    try {
      const r = await fetch(url)
      return { ok: r.ok, status: r.status }
    } catch (e) {
      return { ok: false, status: -1, error: String(e) }
    }
  }, `${SIDECAR}${path}`)
}

test('QA: snippets removal + backups list + browse backup', async () => {
  test.setTimeout(180_000)
  await mkdir(ARTIFACT_OUT, { recursive: true })
  await mkdir(SHARED_OUT, { recursive: true })

  const userData = await mkdtemp(join(tmpdir(), 'flist-workbench-qa-backups-'))

  execSync(
    `uv run --quiet python ${resolve(__dirname, 'seed-backups-qa.py')}`,
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
  await window.waitForTimeout(3000)

  // Dismiss any sign-in modal opened on first launch.
  await window.keyboard.press('Escape')
  await window.waitForTimeout(400)

  // ========== CHECKPOINT 1: SNIPPETS REMOVED ==========
  const docsResp = await fetchStatus(window, '/documents')
  if (docsResp.status === 404) {
    setStatus(
      'snippets-backend-documents',
      'pass',
      `GET /documents -> 404 (got ${docsResp.status})`
    )
  } else {
    setStatus(
      'snippets-backend-documents',
      'fail',
      `expected 404, got ${docsResp.status}`
    )
  }

  const foldersResp = await fetchStatus(window, '/folders')
  if (foldersResp.status === 404) {
    setStatus(
      'snippets-backend-folders',
      'pass',
      `GET /folders -> 404 (got ${foldersResp.status})`
    )
  } else {
    setStatus(
      'snippets-backend-folders',
      'fail',
      `expected 404, got ${foldersResp.status}`
    )
  }

  // Frontend: no "Snippets" anywhere in sidebar.
  const snippetTextCount = await window
    .getByText(/snippets?/i)
    .count()
    .catch(() => -1)
  if (snippetTextCount === 0) {
    setStatus('snippets-ui-absent', 'pass', 'no Snippets text in DOM')
  } else {
    // Could be false positives. Capture for human review.
    await dualShot(window, 'qa-snippets-ui-suspect')
    setStatus(
      'snippets-ui-absent',
      'fail',
      `found ${snippetTextCount} elements matching /snippets?/i — see qa-snippets-ui-suspect.png`
    )
  }

  // Editor pane buttons: Save snippet / History should not exist.
  const saveSnippetCount = await window
    .getByRole('button', { name: /save snippet/i })
    .count()
    .catch(() => -1)
  const historyCount = await window
    .getByRole('button', { name: /^history$/i })
    .count()
    .catch(() => -1)
  if (saveSnippetCount === 0 && historyCount === 0) {
    setStatus(
      'snippets-editor-buttons-absent',
      'pass',
      'no Save-snippet / History buttons in editor'
    )
  } else {
    setStatus(
      'snippets-editor-buttons-absent',
      'fail',
      `save-snippet=${saveSnippetCount}, history=${historyCount}`
    )
  }

  await dualShot(window, 'qa-initial-no-character')

  // ========== CHECKPOINT 2: NO-CHARACTER EMPTY STATE ==========
  const noCharText = await window
    .getByText(/select a character to see backups/i)
    .first()
    .isVisible()
    .catch(() => false)
  if (noCharText) {
    setStatus(
      'backups-no-character-empty',
      'pass',
      '"Select a character to see backups." visible with no active character'
    )
  } else {
    setStatus(
      'backups-no-character-empty',
      'fail',
      'expected empty-state text "Select a character to see backups." not found'
    )
  }

  // ========== CHECKPOINT 3: PICK CHARACTER 9001 (has 2 backups) ==========
  const picker = window.getByTestId('char-picker')
  if (!(await picker.isVisible().catch(() => false))) {
    setStatus('char-picker-visible', 'blocked', 'char-picker testid not visible')
    await dualShot(window, 'qa-char-picker-missing')
    await app.close()
    await writeFile(
      resolve(ARTIFACT_OUT, 'qa-report.json'),
      JSON.stringify(report, null, 2)
    )
    return
  }
  setStatus('char-picker-visible', 'pass', 'char-picker rendered')

  await picker.locator('button').first().click()
  await window.waitForTimeout(400)
  await window
    .getByRole('button', { name: /Backup Test One/i })
    .first()
    .click()
  await window.waitForTimeout(1500)

  await dualShot(window, 'qa-char-9001-active')

  // List rendering: rows should be present.
  // Selectors are not known — we use heuristics around the FlistCharacterZone
  // and look for rows containing date/size text.
  const backupListRoot = window
    .locator(
      '[data-testid*="backups-list"],[data-testid*="backup-list"],[class*="backups"]'
    )
    .first()
  const rootCount = await backupListRoot.count()
  if (rootCount === 0) {
    setStatus(
      'backups-list-container',
      'fail',
      'no [data-testid*=backup-list] or .backups* container found in DOM'
    )
  } else {
    setStatus('backups-list-container', 'pass', `container located (${rootCount} matches)`)
  }

  // Heuristic: rows showing "Today" or recent date plus size suffix.
  const rowCandidates = await window
    .locator(
      '[data-testid*="backup-row"],[data-testid*="backup-item"],[class*="backup-row"],[class*="backup-item"]'
    )
    .count()
    .catch(() => 0)
  const todayCount = await window
    .getByText(/today/i)
    .count()
    .catch(() => 0)
  if (rowCandidates >= 2 || todayCount >= 2) {
    setStatus(
      'backups-rows-rendered',
      'pass',
      `rows visible (rowSel=${rowCandidates}, todayText=${todayCount})`
    )
  } else {
    setStatus(
      'backups-rows-rendered',
      'fail',
      `expected >=2 rows for character 9001 (rowSel=${rowCandidates}, todayText=${todayCount})`
    )
  }

  // ========== CHECKPOINT 4: RIGHT-CLICK CONTEXT MENU ==========
  // Try the first row candidate.
  const firstRow = window
    .locator(
      '[data-testid*="backup-row"],[data-testid*="backup-item"],[class*="backup-row"],[class*="backup-item"]'
    )
    .first()
  let menuOpened = false
  if (await firstRow.count()) {
    await firstRow.click({ button: 'right' })
    await window.waitForTimeout(400)
    const browseMenuItem = window
      .getByRole('menuitem', { name: /browse backup/i })
      .or(window.getByText(/^browse backup$/i))
    if (await browseMenuItem.first().isVisible().catch(() => false)) {
      menuOpened = true
      setStatus(
        'backups-ctx-menu-shows-browse',
        'pass',
        'right-click reveals "Browse backup"'
      )
      await dualShot(window, 'qa-context-menu-open')

      // Try Escape to dismiss.
      await window.keyboard.press('Escape')
      await window.waitForTimeout(300)
      const stillOpen = await browseMenuItem.first().isVisible().catch(() => false)
      if (!stillOpen) {
        setStatus(
          'backups-ctx-menu-escape-dismiss',
          'pass',
          'Escape closes context menu'
        )
      } else {
        setStatus(
          'backups-ctx-menu-escape-dismiss',
          'fail',
          'menu still visible after Escape'
        )
      }

      // Re-open and dismiss by outside click.
      await firstRow.click({ button: 'right' })
      await window.waitForTimeout(300)
      await window.mouse.click(5, 5)
      await window.waitForTimeout(300)
      const stillOpen2 = await browseMenuItem.first().isVisible().catch(() => false)
      if (!stillOpen2) {
        setStatus(
          'backups-ctx-menu-outside-dismiss',
          'pass',
          'outside click closes context menu'
        )
      } else {
        setStatus(
          'backups-ctx-menu-outside-dismiss',
          'fail',
          'menu still visible after outside click'
        )
      }
    } else {
      setStatus(
        'backups-ctx-menu-shows-browse',
        'fail',
        'right-click did not produce "Browse backup" menu item'
      )
      await dualShot(window, 'qa-context-menu-missing')
    }
  } else {
    setStatus(
      'backups-ctx-menu-shows-browse',
      'blocked',
      'no row selector found to right-click on'
    )
  }

  // ========== CHECKPOINT 5: TRIGGER BROWSE BACKUP ==========
  if (menuOpened) {
    await firstRow.click({ button: 'right' })
    await window.waitForTimeout(300)
    await window
      .getByRole('menuitem', { name: /browse backup/i })
      .or(window.getByText(/^browse backup$/i))
      .first()
      .click()
    await window.waitForTimeout(1200)

    const viewingPill = window.getByText(/viewing backup.*read-only/i).first()
    if (await viewingPill.isVisible().catch(() => false)) {
      setStatus(
        'browse-backup-header-pill',
        'pass',
        '"Viewing backup … read-only" header pill visible'
      )
    } else {
      setStatus(
        'browse-backup-header-pill',
        'fail',
        '"Viewing backup" header pill not found'
      )
    }

    const backBtn = window.getByRole('button', { name: /back to working copy/i }).first()
    if (await backBtn.isVisible().catch(() => false)) {
      setStatus(
        'browse-backup-back-button',
        'pass',
        '"Back to working copy" button visible'
      )
    } else {
      setStatus(
        'browse-backup-back-button',
        'fail',
        '"Back to working copy" button not found'
      )
    }

    // Tabs.
    const tabNames = ['Description', 'Profile fields', 'Kinks', 'Images']
    const missingTabs: string[] = []
    for (const name of tabNames) {
      const t = window.getByRole('tab', { name: new RegExp(`^${name}$`) }).first()
      const visible = await t.isVisible().catch(() => false)
      if (!visible) missingTabs.push(name)
    }
    if (missingTabs.length === 0) {
      setStatus(
        'browse-backup-tabs',
        'pass',
        'all four tabs present: Description / Profile fields / Kinks / Images'
      )
    } else {
      setStatus(
        'browse-backup-tabs',
        'fail',
        `missing tabs: ${missingTabs.join(', ')}`
      )
    }
    await dualShot(window, 'qa-browse-backup-active')

    // ========== CHECKPOINT 6: BACK TO WORKING COPY ==========
    if (await backBtn.isVisible().catch(() => false)) {
      await backBtn.click()
      await window.waitForTimeout(800)
      const stillViewing = await window
        .getByText(/viewing backup.*read-only/i)
        .first()
        .isVisible()
        .catch(() => false)
      if (!stillViewing) {
        setStatus(
          'browse-backup-exit-button',
          'pass',
          '"Back to working copy" returns to editor'
        )
      } else {
        setStatus(
          'browse-backup-exit-button',
          'fail',
          'header pill still visible after clicking Back'
        )
      }
      await dualShot(window, 'qa-after-back-to-working')
    } else {
      setStatus(
        'browse-backup-exit-button',
        'blocked',
        'no back button to test'
      )
    }

    // ========== CHECKPOINT 7: DOUBLE-CLICK ROW TRIGGERS BROWSE ==========
    await firstRow.dblclick()
    await window.waitForTimeout(1200)
    const dblViewing = await window
      .getByText(/viewing backup.*read-only/i)
      .first()
      .isVisible()
      .catch(() => false)
    if (dblViewing) {
      setStatus(
        'backups-row-dblclick-triggers-browse',
        'pass',
        'double-click on backup row enters browse mode'
      )
      await dualShot(window, 'qa-browse-via-dblclick')
    } else {
      setStatus(
        'backups-row-dblclick-triggers-browse',
        'fail',
        'double-click did not enter browse mode'
      )
    }

    // ========== CHECKPOINT 8: SWITCHING CHARACTER EXITS BROWSE ==========
    // Switch to character 9002 (Legacy Backup).
    await picker.locator('button').first().click()
    await window.waitForTimeout(300)
    await window
      .getByRole('button', { name: /Legacy Backup/i })
      .first()
      .click()
    await window.waitForTimeout(1500)
    const stillViewingAfterSwitch = await window
      .getByText(/viewing backup.*read-only/i)
      .first()
      .isVisible()
      .catch(() => false)
    if (!stillViewingAfterSwitch) {
      setStatus(
        'browse-backup-char-switch-exits',
        'pass',
        'switching characters exits browse mode'
      )
    } else {
      setStatus(
        'browse-backup-char-switch-exits',
        'fail',
        'browse mode persisted across character switch'
      )
    }
    await dualShot(window, 'qa-after-char-switch')
  }

  // ========== CHECKPOINT 9: LEGACY 410 PATH ==========
  // We're now on Legacy Backup (9002). It has 1 backup, no working.json.
  await window.waitForTimeout(800)
  const legacyRow = window
    .locator(
      '[data-testid*="backup-row"],[data-testid*="backup-item"],[class*="backup-row"],[class*="backup-item"]'
    )
    .first()
  if (await legacyRow.count()) {
    await legacyRow.dblclick()
    await window.waitForTimeout(1500)
    const legacyMsg = await window
      .getByText(/predates browse support/i)
      .first()
      .isVisible()
      .catch(() => false)
    if (legacyMsg) {
      setStatus(
        'browse-backup-legacy-410',
        'pass',
        '"predates Browse support" message shown for legacy backup'
      )
    } else {
      // Try alternative wording.
      const alt = await window
        .getByText(/back up now/i)
        .first()
        .isVisible()
        .catch(() => false)
      if (alt) {
        setStatus(
          'browse-backup-legacy-410',
          'pass',
          '"Back up now" hint message visible (partial match)'
        )
      } else {
        setStatus(
          'browse-backup-legacy-410',
          'fail',
          'no legacy 410 message found'
        )
      }
    }
    await dualShot(window, 'qa-legacy-410-state')
  } else {
    setStatus(
      'browse-backup-legacy-410',
      'blocked',
      'no row in legacy character to trigger 410 path'
    )
  }

  // ========== CHECKPOINT 10: EMPTY-STATE FOR CHARACTER W/O BACKUPS ==========
  // We need a character with NO backups. Neither seeded character qualifies.
  // Skip with a 'blocked' note unless we can find such a state in the UI.
  setStatus(
    'backups-no-backups-empty',
    'blocked',
    'both seeded characters have >=1 backup; empty-list state not exercised in this run'
  )

  await writeFile(
    resolve(ARTIFACT_OUT, 'qa-report.json'),
    JSON.stringify(report, null, 2)
  )

  // eslint-disable-next-line no-console
  console.log('\n========== QA REPORT ==========\n' + JSON.stringify(report, null, 2))

  await app.close()
})
