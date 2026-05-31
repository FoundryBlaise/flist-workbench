import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const OUT = resolve(__dirname, 'artifacts')

const observations: Record<string, unknown> = {}

async function shot(window: Page, name: string, fullPage = false) {
  await window.screenshot({ path: resolve(OUT, `${name}.png`), fullPage })
}

// Skipped: Fetch Profile UI removed — re-enable if the button comes back.
test.skip('ux part 3 – error/edge', async () => {
  await mkdir(OUT, { recursive: true })
  const root = resolve(__dirname, '../..')
  const app: ElectronApplication = await electron.launch({
    args: [resolve(root, 'out/main/main.js')],
    cwd: root,
    env: { ...process.env, NODE_ENV: 'test' }
  })
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await window.setViewportSize({ width: 1400, height: 900 })

  try {
    await expect(window.getByTestId('sidecar-status')).toContainText('ok', { timeout: 30_000 })

    const fetchInput = window.getByTestId('profile-fetch-input')
    const fetchButton = window.getByRole('button', { name: /fetch/i })

    // 1) Bogus profile name — capture error
    await fetchInput.fill('zzz-not-a-real-character-xyz')
    await fetchButton.click()
    // wait for any change
    await window.waitForTimeout(4000)
    await shot(window, 'e01-bogus-name-result')
    const bogusBody = await window.evaluate(() => document.body.innerText)
    observations['bogus-text-mentions-404'] = bogusBody.includes('404')
    observations['bogus-text-mentions-not-found'] = /not\s*found/i.test(bogusBody)
    observations['bogus-text-mentions-error'] = /error/i.test(bogusBody)
    const errorMatch = bogusBody.match(/(\w*error[^\n]*|404[^\n]*|not found[^\n]*|failed[^\n]*)/i)
    observations['bogus-error-line'] = errorMatch ? errorMatch[0].trim().slice(0, 200) : null

    // 2) Empty fetch
    await fetchInput.fill('')
    await fetchButton.click()
    await window.waitForTimeout(1000)
    await shot(window, 'e02-empty-fetch')
    const emptyDocs = await window.locator('.doc-name').allTextContents()
    observations['after-empty-fetch-docs'] = emptyDocs

    // 3) Whitespace only
    await fetchInput.fill('   ')
    await fetchButton.click()
    await window.waitForTimeout(1500)
    await shot(window, 'e03-whitespace-fetch')

    // 4) Special chars
    await fetchInput.fill('<script>alert(1)</script>')
    await fetchButton.click()
    await window.waitForTimeout(2500)
    await shot(window, 'e04-special-chars')

    // 5) Now load Svenja Lindstroem properly
    await fetchInput.fill('Svenja Lindstroem')
    const svenjaStart = Date.now()
    await fetchButton.click()
    let svenjaLoaded = false
    try {
      await expect(window.locator('.doc-name')).toContainText('Svenja Lindstroem.bbcode', { timeout: 30_000 })
      svenjaLoaded = true
    } catch {
      svenjaLoaded = false
    }
    observations['svenja-load-ms'] = Date.now() - svenjaStart
    observations['svenja-loaded'] = svenjaLoaded
    await window.waitForTimeout(2500)
    await shot(window, 'e05-svenja-loaded')

    const preview = window.getByTestId('preview-body')
    const previewSummary = await preview.evaluate((el) => {
      const counts: Record<string, number> = {}
      el.querySelectorAll('*').forEach((n) => {
        const k = n.tagName.toLowerCase() + (n.className ? '.' + String(n.className).split(/\s+/)[0] : '')
        counts[k] = (counts[k] || 0) + 1
      })
      return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 20)
    })
    observations['svenja-preview-dom-summary'] = previewSummary

    // 6) Scroll the preview to see Svenja content
    await preview.evaluate((el) => (el.scrollTop = 0))
    await window.waitForTimeout(300)
    await shot(window, 'e06-svenja-top')
    await preview.evaluate((el) => (el.scrollTop = 800))
    await window.waitForTimeout(300)
    await shot(window, 'e07-svenja-mid')

    // 7) Look for any details on Svenja
    const svenjaDetails = await preview.locator('details').count()
    observations['svenja-details-count'] = svenjaDetails
    if (svenjaDetails > 0) {
      const firstDet = preview.locator('details').first()
      await firstDet.scrollIntoViewIfNeeded()
      const beforeOpen = await firstDet.evaluate((d: HTMLDetailsElement) => d.open)
      observations['svenja-first-details-open-default'] = beforeOpen
      await firstDet.locator('summary').click()
      await window.waitForTimeout(300)
      const afterOpen = await firstDet.evaluate((d: HTMLDetailsElement) => d.open)
      observations['svenja-first-details-open-after-click'] = afterOpen
      await shot(window, 'e08-svenja-details-clicked')
    }

    // 8) Toolbar tests with a real selection
    const editor = window.getByTestId('editor-cm').locator('.cm-content')
    await editor.click()
    await window.keyboard.press('ControlOrMeta+End')
    await window.keyboard.press('Enter')
    await window.keyboard.type('SELECT-ME')
    await window.keyboard.press('Shift+Home')
    await shot(window, 'e09-selection-before-toolbar')
    // Click Italic
    await window.getByRole('button', { name: 'Italic' }).click()
    await window.waitForTimeout(300)
    await shot(window, 'e10-after-italic')
    // Now without selection — click italic — see if it inserts [i][/i]
    await window.keyboard.press('ControlOrMeta+End')
    const lengthBefore = await editor.evaluate((el) => el.textContent?.length || 0)
    await window.getByRole('button', { name: 'Italic' }).click()
    await window.waitForTimeout(300)
    const lengthAfter = await editor.evaluate((el) => el.textContent?.length || 0)
    observations['italic-no-selection-chars-inserted'] = lengthAfter - lengthBefore
    await shot(window, 'e11-italic-no-selection')

    // 9) Character picker — try selecting a different character
    const picker = window.getByTestId('char-picker')
    await picker.click()
    await window.waitForTimeout(400)
    await shot(window, 'e12-picker-open')
    // Click a different name — Azure Viper
    const azure = window.locator('button:has-text("Azure Viper")').first()
    const azureCount = await azure.count()
    observations['picker-azure-found'] = azureCount
    if (azureCount) {
      await azure.click()
      await window.waitForTimeout(800)
      await shot(window, 'e13-picker-changed-azure')
      const activeChar = await window.evaluate(() => {
        const el = document.querySelector('[data-testid="char-picker"]')
        return el?.textContent || ''
      })
      observations['active-char-after-pick'] = activeChar
    }

    // 10) Try keyboard shortcut for Bold (Ctrl+B) — does it work?
    await editor.click()
    await window.keyboard.press('ControlOrMeta+End')
    await window.keyboard.type(' KBD-BOLD ')
    await window.keyboard.press('Shift+Home')
    const beforeKB = await editor.evaluate((el) => el.textContent?.length || 0)
    await window.keyboard.press('ControlOrMeta+B')
    await window.waitForTimeout(300)
    const afterKB = await editor.evaluate((el) => el.textContent?.length || 0)
    observations['ctrl-b-chars-diff'] = afterKB - beforeKB
    await shot(window, 'e14-after-ctrl-b')

    // 11) Drag-drop / file paste — try pasting plain text
    await editor.click()
    await window.keyboard.press('ControlOrMeta+End')
    await window.evaluate(() => {
      navigator.clipboard.writeText('[b]pasted bold[/b]').catch(() => {})
    })
    await window.waitForTimeout(200)
    // Just type something so we have a visible change anyway
    await window.keyboard.type(' DONE ')
    await shot(window, 'e15-paste-attempt')

    // 12) Window very narrow
    await window.setViewportSize({ width: 600, height: 900 })
    await window.waitForTimeout(400)
    await shot(window, 'e16-narrow')
    await window.setViewportSize({ width: 400, height: 700 })
    await window.waitForTimeout(400)
    await shot(window, 'e17-very-narrow')
    await window.setViewportSize({ width: 1400, height: 900 })
    await window.waitForTimeout(400)
    await shot(window, 'e18-restored')

    // 13) Tooltip on toolbar buttons
    const boldBtn = window.getByRole('button', { name: 'Bold' })
    await boldBtn.hover()
    await window.waitForTimeout(800)
    await shot(window, 'e19-bold-hover')
    const title = await boldBtn.getAttribute('title')
    const ariaLabel = await boldBtn.getAttribute('aria-label')
    observations['bold-button-title'] = title
    observations['bold-button-aria'] = ariaLabel

    // 14) Click on the bblist on the left (Scratch.bbcode) — does it switch back?
    const scratchDoc = window.locator('.doc-name').filter({ hasText: 'Scratch.bbcode' })
    const scratchCount = await scratchDoc.count()
    observations['scratch-doc-present'] = scratchCount
    if (scratchCount) {
      await scratchDoc.first().click()
      await window.waitForTimeout(500)
      await shot(window, 'e20-back-to-scratch')
    }

    // 15) Inspect log viewer pills more carefully — find toolbar buttons IC/OOC
    await window.getByRole('tab', { name: /logs/i }).click()
    await window.waitForTimeout(500)
    const partners = window.getByTestId('partner-list').locator('li button')
    const pcount = await partners.count()
    // Open a sized partner
    for (let i = 0; i < pcount; i++) {
      const l = (await partners.nth(i).locator('.label').textContent()) || ''
      if (!l.startsWith('#')) {
        await partners.nth(i).click()
        break
      }
    }
    await window.waitForTimeout(2000)
    await shot(window, 'e21-partner-opened')

    // Find IC/OOC/SYSTEM filter buttons by role (they look like buttons in the toolbar)
    const filterButtons = ['IC', 'OOC', 'SYSTEM']
    for (const name of filterButtons) {
      const b = window.getByRole('button', { name, exact: true })
      const c = await b.count()
      observations[`filter-${name}-button-count`] = c
      if (c) {
        const pressedBefore = await b.first().getAttribute('aria-pressed')
        observations[`filter-${name}-pressed-before`] = pressedBefore
        const classBefore = await b.first().getAttribute('class')
        observations[`filter-${name}-class-before`] = classBefore
        await b.first().click()
        await window.waitForTimeout(400)
        const pressedAfter = await b.first().getAttribute('aria-pressed')
        const classAfter = await b.first().getAttribute('class')
        observations[`filter-${name}-pressed-after`] = pressedAfter
        observations[`filter-${name}-class-after`] = classAfter
        const msgCount = await window.getByTestId('log-body').locator('.log-msg').count()
        observations[`filter-${name}-msg-count-after`] = msgCount
        await shot(window, `e22-after-filter-${name}`)
        // re-toggle
        await b.first().click()
        await window.waitForTimeout(200)
      }
    }

    // 16) Switch to a channel with TONS of messages (#german ooc 619.6kb)
    const germanOoc = partners.filter({ hasText: 'german ooc' })
    if (await germanOoc.count()) {
      const t0 = Date.now()
      await germanOoc.first().click()
      // wait for log body to populate
      await expect(window.getByTestId('log-body').locator('.log-msg').first()).toBeVisible({ timeout: 30_000 }).catch(() => {})
      observations['german-ooc-load-ms'] = Date.now() - t0
      await window.waitForTimeout(800)
      const msgCount = await window.getByTestId('log-body').locator('.log-msg').count()
      observations['german-ooc-msg-count-rendered'] = msgCount
      await shot(window, 'e23-german-ooc-channel')

      // search in this big channel
      const search = window.locator('input[placeholder*="earch" i]').first()
      await search.fill('haha')
      await window.waitForTimeout(1500)
      const afterSearch = await window.getByTestId('log-body').locator('.log-msg').count()
      observations['german-ooc-search-haha-count'] = afterSearch
      await shot(window, 'e24-german-ooc-search')
      await search.fill('')
    }

    // 17) Last screenshot — final state
    await window.setViewportSize({ width: 1400, height: 900 })
    await shot(window, 'e25-final', true)
  } finally {
    await writeFile(resolve(OUT, 'observations3.json'), JSON.stringify(observations, null, 2))
    await app.close()
  }
})
