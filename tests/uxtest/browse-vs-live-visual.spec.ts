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

type Result = {
  status: 'pass' | 'fail' | 'partial' | 'blocked'
  note: string
}
const report: Record<string, Result> = {}

const setStatus = (key: string, status: Result['status'], note: string) => {
  report[key] = { status, note }
  // eslint-disable-next-line no-console
  console.log(`QA[${status.toUpperCase()}] ${key}: ${note}`)
}

const dualShot = async (window: Page, name: string) => {
  await window.screenshot({ path: resolve(ARTIFACT_OUT, `${name}.png`), fullPage: false })
  await window.screenshot({ path: resolve(SHARED_OUT, `${name}.png`), fullPage: false })
}

const shotRegion = async (window: Page, name: string, locator: ReturnType<Page['locator']>) => {
  try {
    await locator.screenshot({ path: resolve(SHARED_OUT, `${name}.png`) })
    return true
  } catch {
    return false
  }
}

const countNodes = async (window: Page, selector: string) => {
  return await window.locator(selector).count().catch(() => -1)
}

test('Browse Backup renders identically to From-F-list (visual identity)', async () => {
  test.setTimeout(240_000)
  await mkdir(ARTIFACT_OUT, { recursive: true })
  await mkdir(SHARED_OUT, { recursive: true })

  const userData = await mkdtemp(join(tmpdir(), 'flist-workbench-browse-vs-live-'))

  execSync(
    `uv run --quiet python ${resolve(__dirname, 'seed-browse-vs-live-qa.py')}`,
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
  await window.keyboard.press('Escape')
  await window.waitForTimeout(400)

  // ---- pick character ----
  const picker = window.getByTestId('char-picker')
  await expect(picker).toBeVisible({ timeout: 15_000 })
  await picker.locator('button').first().click()
  await window.waitForTimeout(400)
  await window
    .getByRole('button', { name: /Visual Identity Probe/i })
    .first()
    .click()
  await window.waitForTimeout(1800)

  // ---- enter "From F-list" mode (Live read-only) ----
  // The working-sets zone is collapsed under a disclosure on first paint.
  // Try the documented testid first.
  const fromFlistTestid = window.getByTestId('flist-zone-from-flist').first()
  let fromFlistClicked = false
  if (await fromFlistTestid.count()) {
    await fromFlistTestid.click()
    fromFlistClicked = true
    await window.waitForTimeout(1500)
  } else {
    // Some builds may render From-F-list as a row inside the zone but only
    // after expanding the working-sets section.
    const zoneToggle = window.getByText(/working sets|f-list profile sets/i).first()
    if (await zoneToggle.isVisible().catch(() => false)) {
      await zoneToggle.click()
      await window.waitForTimeout(400)
    }
    if (await fromFlistTestid.count()) {
      await fromFlistTestid.click()
      fromFlistClicked = true
      await window.waitForTimeout(1500)
    } else {
      const txt = window.getByText(/from f-?list/i).first()
      if (await txt.isVisible().catch(() => false)) {
        await txt.click()
        fromFlistClicked = true
        await window.waitForTimeout(1500)
      }
    }
  }
  if (!fromFlistClicked) {
    setStatus('enter-from-flist', 'blocked', 'could not find a "From F-list" affordance in sidebar')
  } else {
    setStatus('enter-from-flist', 'pass', 'From-F-list mode entered')
  }

  // Ensure Description tab is selected.
  const descTab = window.getByRole('tab', { name: /^description/i }).first()
  if (await descTab.count()) {
    await descTab.click()
    await window.waitForTimeout(400)
  }

  // Force Split view so the right-side LIVE PREVIEW pane is on-screen.
  await window.evaluate(() => {
    const btn = document.querySelector<HTMLButtonElement>('[data-testid="view-mode-split"]')
    btn?.click()
  })
  await window.waitForTimeout(800)

  // Try to settle inline images / mapping.
  await window.waitForTimeout(2500)

  // Locate the workspace row that we will screenshot for comparison.
  // Prefer testid; fall back to broader class search.
  const workspaceCandidates = [
    '[data-testid="editor-workspace-row"]',
    '#editor-workspace-row',
    '[data-testid="editor-pane"]',
    'main',
    '.editor-pane',
    '.editor'
  ]
  let workspaceSel: string | null = null
  for (const sel of workspaceCandidates) {
    if ((await countNodes(window, sel)) > 0) {
      workspaceSel = sel
      break
    }
  }
  if (!workspaceSel) {
    setStatus('locate-workspace-row', 'blocked', 'no workspace/editor selector matched')
  } else {
    setStatus('locate-workspace-row', 'pass', `using selector ${workspaceSel}`)
  }

  // --- LIVE screenshot ---
  await dualShot(window, 'browse-vs-live-LIVE-fullwindow')
  if (workspaceSel) {
    await shotRegion(window, 'browse-vs-live-LIVE-workspace', window.locator(workspaceSel).first())
  }

  // Inspect what the Live render contains so we can sanity-check Browse against it.
  // Focus on the preview pane (right side) — that's where the F-list profile
  // card chrome is rendered.
  const liveProbe = await window.evaluate(() => {
    const previewRoots = [
      ...Array.from(document.querySelectorAll('[class*="preview"]')),
      ...Array.from(document.querySelectorAll('[data-testid*="preview"]'))
    ]
    const previewRoot = previewRoots
      .map((el) => el as HTMLElement)
      .find((el) => el.offsetWidth > 200 && el.offsetHeight > 200)
    const imgs = Array.from(document.querySelectorAll('img'))
    const inlineImgs = imgs.filter((i) =>
      /inlines?\//i.test(i.src) ||
      /aaaa1111|bbbb2222/.test(i.src) ||
      /eicon/i.test(i.src) ||
      /xariah/i.test(i.src)
    )
    const galleryImgs = imgs.filter((i) => /2000000\d/.test(i.src))
    const bodyText = (previewRoot && (previewRoot as HTMLElement).innerText) || document.body.innerText
    const bracketLiteralsInPreview = (bodyText.match(/\[inline\][^\[]*\[\/inline\]|\[inline\]\w+/gi) || []).length
    const bboldEls = (previewRoot || document.body).querySelectorAll('b, strong').length
    const previewBg = previewRoot ? getComputedStyle(previewRoot).backgroundColor : null
    const colorSwatch = previewRoot
      ? Array.from(previewRoot.querySelectorAll('a,h1,h2,h3,h4,h5,h6,b,i,u,span'))
          .slice(0, 30)
          .map((el) => getComputedStyle(el as HTMLElement).color)
      : []
    return {
      totalImgs: imgs.length,
      inlineImgs: inlineImgs.length,
      galleryImgs: galleryImgs.length,
      bracketLiteralsInPreview,
      bboldEls,
      hasFlistProfileCardClass: !!document.querySelector(
        '[class*="profile-card"],[class*="profileCard"],[class*="flist-profile"],[class*="character-card"]'
      ),
      previewRootFound: !!previewRoot,
      previewBg,
      colorSwatch,
      bodyTextSlice: bodyText.slice(0, 800)
    }
  })
  // eslint-disable-next-line no-console
  console.log('LIVE probe:', JSON.stringify(liveProbe, null, 2))

  // ---- open Backups section + click context menu Browse backup ----
  // Backups section may be collapsed. Look for "Manual backups" header.
  const manualHeader = window
    .getByText(/manual backups?/i)
    .first()
  const autoHeader = window
    .getByText(/automatic backups?/i)
    .first()
  const scheduledHeader = window
    .getByText(/scheduled backups?/i)
    .first()

  const manualVisible = await manualHeader.isVisible().catch(() => false)
  const autoVisible = await autoHeader.isVisible().catch(() => false)
  const scheduledVisible = await scheduledHeader.isVisible().catch(() => false)
  setStatus(
    'backups-three-folders',
    manualVisible && autoVisible && scheduledVisible ? 'pass' : 'fail',
    `manual=${manualVisible} auto=${autoVisible} scheduled=${scheduledVisible}`
  )

  // Find a backup row.
  const backupRow = window
    .locator(
      '[data-testid*="backup-row"],[data-testid*="backup-item"],[class*="backup-row"],[class*="backup-item"]'
    )
    .first()
  const haveRow = (await backupRow.count()) > 0
  if (!haveRow) {
    setStatus('backups-list-row-found', 'fail', 'no backup row selector matched')
    await dualShot(window, 'browse-vs-live-no-backup-row')
  } else {
    setStatus('backups-list-row-found', 'pass', 'backup row located')
  }

  if (haveRow) {
    await backupRow.scrollIntoViewIfNeeded()
    await backupRow.click({ button: 'right' })
    await window.waitForTimeout(400)
    const browseItem = window
      .getByRole('menuitem', { name: /browse backup/i })
      .or(window.getByText(/^browse backup$/i))
      .first()
    if (await browseItem.isVisible().catch(() => false)) {
      await browseItem.click()
      await window.waitForTimeout(2500)
      setStatus('open-browse-backup', 'pass', '"Browse backup" menuitem invoked')
    } else {
      setStatus('open-browse-backup', 'fail', 'no Browse backup menuitem after right-click')
      await dualShot(window, 'browse-vs-live-no-browse-menuitem')
    }
  }

  // Wait for the header pill, the only intentional visual difference.
  const browseHeader = window.getByText(/viewing backup.*read-only/i).first()
  const browseHeaderVisible = await browseHeader.isVisible().catch(() => false)
  if (browseHeaderVisible) {
    setStatus('browse-header-pill', 'pass', '"Viewing backup … read-only" pill present')
  } else {
    setStatus('browse-header-pill', 'fail', 'no header pill found')
  }
  await window.waitForTimeout(1500)

  // --- BROWSE screenshot ---
  await dualShot(window, 'browse-vs-live-BROWSE-fullwindow')
  if (workspaceSel) {
    await shotRegion(window, 'browse-vs-live-BROWSE-workspace', window.locator(workspaceSel).first())
  }

  const browseProbe = await window.evaluate(() => {
    const previewRoots = [
      ...Array.from(document.querySelectorAll('[class*="preview"]')),
      ...Array.from(document.querySelectorAll('[data-testid*="preview"]'))
    ]
    const previewRoot = previewRoots
      .map((el) => el as HTMLElement)
      .find((el) => el.offsetWidth > 200 && el.offsetHeight > 200)
    const imgs = Array.from(document.querySelectorAll('img'))
    const inlineImgs = imgs.filter((i) =>
      /inlines?\//i.test(i.src) ||
      /aaaa1111|bbbb2222/.test(i.src) ||
      /eicon/i.test(i.src) ||
      /xariah/i.test(i.src)
    )
    const galleryImgs = imgs.filter((i) => /2000000\d/.test(i.src))
    const bodyText = (previewRoot && (previewRoot as HTMLElement).innerText) || document.body.innerText
    const bracketLiteralsInPreview = (bodyText.match(/\[inline\][^\[]*\[\/inline\]|\[inline\]\w+/gi) || []).length
    const bboldEls = (previewRoot || document.body).querySelectorAll('b, strong').length
    const previewBg = previewRoot ? getComputedStyle(previewRoot).backgroundColor : null
    const colorSwatch = previewRoot
      ? Array.from(previewRoot.querySelectorAll('a,h1,h2,h3,h4,h5,h6,b,i,u,span'))
          .slice(0, 30)
          .map((el) => getComputedStyle(el as HTMLElement).color)
      : []
    return {
      totalImgs: imgs.length,
      inlineImgs: inlineImgs.length,
      galleryImgs: galleryImgs.length,
      bracketLiteralsInPreview,
      bboldEls,
      hasFlistProfileCardClass: !!document.querySelector(
        '[class*="profile-card"],[class*="profileCard"],[class*="flist-profile"],[class*="character-card"]'
      ),
      previewRootFound: !!previewRoot,
      previewBg,
      colorSwatch,
      bodyTextSlice: bodyText.slice(0, 800)
    }
  })
  // eslint-disable-next-line no-console
  console.log('BROWSE probe:', JSON.stringify(browseProbe, null, 2))

  // Compare the structural signals.
  const inlineParity = liveProbe.inlineImgs > 0 && browseProbe.inlineImgs >= liveProbe.inlineImgs
  setStatus(
    'inline-images-rendered',
    inlineParity ? 'pass' : 'fail',
    `live=${liveProbe.inlineImgs} browse=${browseProbe.inlineImgs}`
  )

  // Parity matters more than absolute zero — if Live shows bracket literals
  // for unresolved inlines, Browse should show the same. The regression we
  // worry about is Browse showing MORE bracket literals than Live (= old
  // homegrown renderer that didn't parse [inline] at all).
  const parityBrackets =
    browseProbe.bracketLiteralsInPreview <= liveProbe.bracketLiteralsInPreview
  setStatus(
    'inline-bracket-literal-parity',
    parityBrackets ? 'pass' : 'fail',
    `live=${liveProbe.bracketLiteralsInPreview} browse=${browseProbe.bracketLiteralsInPreview}`
  )

  setStatus(
    'gallery-images-rendered',
    browseProbe.galleryImgs >= liveProbe.galleryImgs && liveProbe.galleryImgs > 0
      ? 'pass'
      : liveProbe.galleryImgs === 0
        ? 'blocked'
        : 'fail',
    `live=${liveProbe.galleryImgs} browse=${browseProbe.galleryImgs}`
  )

  setStatus(
    'flist-profile-card-chrome',
    browseProbe.hasFlistProfileCardClass === liveProbe.hasFlistProfileCardClass
      ? 'pass'
      : 'fail',
    `live=${liveProbe.hasFlistProfileCardClass} browse=${browseProbe.hasFlistProfileCardClass}`
  )

  // --- Profile fields tab: switch and compare label/value count + screenshots
  const switchToTab = async (label: RegExp) => {
    const t = window.getByRole('tab', { name: label }).first()
    if (await t.count()) {
      await t.click()
      await window.waitForTimeout(700)
      return true
    }
    return false
  }

  // Browse view: profile fields tab
  if (await switchToTab(/^profile fields$/i)) {
    await window.waitForTimeout(500)
    await dualShot(window, 'browse-vs-live-BROWSE-profile-fields')
    const browseFields = await window.locator('label,dt,th,[class*="label"]').count()
    setStatus('browse-profile-fields-tab', 'pass', `labels=${browseFields}`)
  } else {
    setStatus('browse-profile-fields-tab', 'fail', 'Profile fields tab not found in browse mode')
  }

  // Browse: kinks tab
  if (await switchToTab(/^kinks(\s*\d*)?$/i)) {
    await window.waitForTimeout(700)
    await dualShot(window, 'browse-vs-live-BROWSE-kinks')
    // Look for the four bucket headers
    const buckets = ['fave', 'yes', 'maybe', 'no']
    const hits: Record<string, boolean> = {}
    for (const b of buckets) {
      hits[b] = await window.getByText(new RegExp(`(${b}s|${b})`, 'i')).first().isVisible().catch(() => false)
    }
    setStatus('browse-kinks-buckets', 'pass', JSON.stringify(hits))
  } else {
    setStatus('browse-kinks-tab', 'fail', 'Kinks tab not found in browse mode')
  }

  // Browse: images tab
  if (await switchToTab(/^images$/i)) {
    await window.waitForTimeout(700)
    await dualShot(window, 'browse-vs-live-BROWSE-images')
    const galleryImgs = await window.locator('img').count()
    setStatus('browse-images-tab', galleryImgs > 0 ? 'pass' : 'fail', `imgs=${galleryImgs}`)
  } else {
    setStatus('browse-images-tab', 'fail', 'Images tab not found in browse mode')
  }

  // Switch back to Description for cleanup.
  await switchToTab(/^description$/i)
  await window.waitForTimeout(400)

  // ---- "Back to working copy" smoke test ----
  const backBtn = window.getByRole('button', { name: /back to working copy/i }).first()
  if (await backBtn.isVisible().catch(() => false)) {
    await backBtn.click()
    await window.waitForTimeout(1200)
    const stillViewing = await window
      .getByText(/viewing backup.*read-only/i)
      .first()
      .isVisible()
      .catch(() => false)
    setStatus(
      'back-to-working-copy',
      stillViewing ? 'fail' : 'pass',
      stillViewing ? 'header pill still visible after Back' : 'returned to prior mode'
    )
    await dualShot(window, 'browse-vs-live-after-back')
  } else {
    setStatus('back-to-working-copy', 'blocked', 'no Back-to-working-copy button visible')
  }

  // ---- Swap between two backups smoke test ----
  // We have only one backup for this character; trigger a second so we can swap.
  const triggerSecond = await window.evaluate(async () => {
    try {
      const r = await fetch('http://127.0.0.1:27384/flist/character/9100/zip-backup', { method: 'POST' })
      return { ok: r.ok, status: r.status }
    } catch (e) {
      return { ok: false, status: -1, error: String(e) }
    }
  })
  // eslint-disable-next-line no-console
  console.log('second backup POST:', JSON.stringify(triggerSecond))
  await window.waitForTimeout(2500)

  const rows = window.locator(
    '[data-testid*="backup-row"],[data-testid*="backup-item"],[class*="backup-row"],[class*="backup-item"]'
  )
  const rowCount = await rows.count()
  if (rowCount >= 2) {
    // Browse first row
    await rows.nth(0).click({ button: 'right' })
    await window.waitForTimeout(300)
    await window.getByRole('menuitem', { name: /browse backup/i }).or(window.getByText(/^browse backup$/i)).first().click()
    await window.waitForTimeout(1500)
    await dualShot(window, 'browse-vs-live-SWAP-A')
    // Right-click second row
    await rows.nth(1).click({ button: 'right' })
    await window.waitForTimeout(300)
    await window.getByRole('menuitem', { name: /browse backup/i }).or(window.getByText(/^browse backup$/i)).first().click()
    await window.waitForTimeout(1500)
    await dualShot(window, 'browse-vs-live-SWAP-B')
    setStatus('swap-between-backups', 'pass', `swapped between 2 backup rows (count=${rowCount})`)
  } else {
    setStatus('swap-between-backups', 'blocked', `only ${rowCount} backup row(s) — swap not exercised`)
  }

  // ---- Character switch closes browse ----
  // First re-enter Browse mode so we can test that switching exits it.
  if (rowCount >= 1) {
    await rows.first().click({ button: 'right' })
    await window.waitForTimeout(300)
    await window.getByRole('menuitem', { name: /browse backup/i })
      .or(window.getByText(/^browse backup$/i)).first().click()
    await window.waitForTimeout(1500)
  }
  await picker.locator('button').first().click()
  await window.waitForTimeout(400)
  const secondCharBtn = window.getByRole('button', { name: /Second Probe/i }).first()
  if (await secondCharBtn.isVisible().catch(() => false)) {
    await secondCharBtn.click()
    await window.waitForTimeout(2000)
    const stillViewing = await window
      .getByText(/viewing backup.*read-only/i)
      .first()
      .isVisible()
      .catch(() => false)
    setStatus(
      'char-switch-closes-browse',
      stillViewing ? 'fail' : 'pass',
      stillViewing ? 'browse mode persisted across char switch' : 'browse closed on switch'
    )
    await dualShot(window, 'browse-vs-live-after-char-switch')
  } else {
    await dualShot(window, 'browse-vs-live-picker-open')
    setStatus('char-switch-closes-browse', 'blocked', 'Second Probe character button not visible in picker')
    await window.keyboard.press('Escape')
  }
  await window.waitForTimeout(300)

  // ---- Download ZIP context-menu item exists ----
  // Re-find backup rows on whatever character is currently active.
  const rowsAfter = window.locator(
    '[data-testid*="backup-row"],[data-testid*="backup-item"],[class*="backup-row"],[class*="backup-item"]'
  )
  const rowsAfterCount = await rowsAfter.count().catch(() => 0)
  if (rowsAfterCount >= 1) {
    await rowsAfter.first().click({ button: 'right', timeout: 5000 }).catch(() => {})
    await window.waitForTimeout(300)
    const dl = window.getByRole('menuitem', { name: /download zip/i })
      .or(window.getByText(/^download zip/i))
      .first()
    if (await dl.isVisible().catch(() => false)) {
      setStatus('download-zip-menuitem-present', 'pass', '"Download ZIP" menuitem visible')
    } else {
      setStatus('download-zip-menuitem-present', 'fail', 'no Download ZIP menuitem')
    }
    await window.keyboard.press('Escape').catch(() => {})
  } else {
    setStatus('download-zip-menuitem-present', 'blocked', `no backup rows on active char (count=${rowsAfterCount})`)
  }

  await writeFile(
    resolve(ARTIFACT_OUT, 'browse-vs-live-report.json'),
    JSON.stringify({ report, liveProbe, browseProbe }, null, 2)
  )

  // eslint-disable-next-line no-console
  console.log('\n========== BROWSE-vs-LIVE REPORT ==========\n' + JSON.stringify(report, null, 2))
  console.log('\nLIVE probe:', JSON.stringify(liveProbe))
  console.log('\nBROWSE probe:', JSON.stringify(browseProbe))

  await app.close()
})
