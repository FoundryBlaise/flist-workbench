import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const OUT = resolve(__dirname, 'artifacts')

const observations: Record<string, unknown> = {}

async function shot(window: Page, name: string, fullPage = false) {
  await window.screenshot({ path: resolve(OUT, `${name}.png`), fullPage })
}

// Skipped: Fetch Profile UI removed — re-enable if the button comes back.
test.skip('ux deep dive', async () => {
  await mkdir(OUT, { recursive: true })
  const root = resolve(__dirname, '../..')
  const app: ElectronApplication = await electron.launch({
    args: [resolve(root, 'out/main/main.js')],
    cwd: root,
    env: { ...process.env, NODE_ENV: 'test' }
  })

  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  // get a real viewport for nicer screenshots
  await window.setViewportSize({ width: 1400, height: 900 }).catch(() => {})

  try {
    const sidecarStatus = window.getByTestId('sidecar-status')
    await expect(sidecarStatus).toContainText('ok', { timeout: 30_000 })

    // Capture the "fetch in flight" state cleanly
    const fetchInput = window.getByTestId('profile-fetch-input')
    const fetchButton = window.getByRole('button', { name: /fetch/i })

    await fetchInput.fill('Azure Viper')
    // fire-and-screenshot quickly
    const clickPromise = fetchButton.click()
    await window.waitForTimeout(50)
    await shot(window, 'd01-fetch-inflight')
    await clickPromise
    await expect(window.locator('.doc-name')).toContainText('Azure Viper.bbcode', { timeout: 30_000 })

    // Wait for images to settle
    await window.waitForTimeout(2500)
    await shot(window, 'd02-azure-loaded-viewport')

    // Scroll the preview through its full content and shot several places
    const preview = window.getByTestId('preview-body')
    await preview.evaluate((el) => (el.scrollTop = 0))
    await window.waitForTimeout(300)
    await shot(window, 'd03-azure-preview-top')

    await preview.evaluate((el) => (el.scrollTop = 400))
    await window.waitForTimeout(300)
    await shot(window, 'd04-azure-preview-400')

    await preview.evaluate((el) => (el.scrollTop = 1200))
    await window.waitForTimeout(300)
    await shot(window, 'd05-azure-preview-1200')

    await preview.evaluate((el) => (el.scrollTop = 2400))
    await window.waitForTimeout(300)
    await shot(window, 'd06-azure-preview-2400')

    await preview.evaluate((el) => (el.scrollTop = el.scrollHeight))
    await window.waitForTimeout(300)
    await shot(window, 'd07-azure-preview-bottom')

    // Dom inspection of preview to find what tags ARE used
    const previewSummary = await preview.evaluate((el) => {
      const counts: Record<string, number> = {}
      el.querySelectorAll('*').forEach((n) => {
        const k = n.tagName.toLowerCase() + (n.className ? '.' + String(n.className).split(/\s+/)[0] : '')
        counts[k] = (counts[k] || 0) + 1
      })
      // Top 20 by count
      return Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 30)
    })
    observations['azure-preview-dom-summary'] = previewSummary

    // Try clicking the first details (any details, not just .bb-collapse) since
    // the BBCode in scratch uses [collapse] and the loaded Azure profile may render
    // with a custom element/markup we haven't accounted for.
    const detailsCount = await preview.locator('details').count()
    observations['azure-details-count'] = detailsCount
    if (detailsCount > 0) {
      const d = preview.locator('details').first()
      await d.scrollIntoViewIfNeeded()
      await d.locator('summary').click()
      await window.waitForTimeout(400)
      await shot(window, 'd08-after-details-click')
    }

    // Hover over an inline char icon to see tooltip / cursor
    const charIcon = preview.locator('img').first()
    if (await charIcon.count()) {
      await charIcon.hover()
      await window.waitForTimeout(400)
      await shot(window, 'd09-image-hover')
      // cursor style
      const cursor = await charIcon.evaluate((el) => getComputedStyle(el).cursor)
      observations['image-cursor'] = cursor
      // is it linked? alt? title?
      const alt = await charIcon.getAttribute('alt')
      const title = await charIcon.getAttribute('title')
      observations['image-alt'] = alt
      observations['image-title'] = title
    }

    // Editor — type rapidly and see how it responds. Test undo too.
    const editorContent = window.getByTestId('editor-cm').locator('.cm-content')
    await editorContent.click()
    await window.keyboard.press('ControlOrMeta+Home')
    await window.keyboard.type('[b]TYPED BY UX[/b] ')
    await window.waitForTimeout(500)
    await shot(window, 'd10-editor-typed-at-top')

    // Undo
    await window.keyboard.press('ControlOrMeta+Z')
    await window.waitForTimeout(200)
    await shot(window, 'd11-after-undo')

    // Try the toolbar with no selection — should it do anything?
    await window.keyboard.press('ControlOrMeta+End')
    const colorBtn = window.getByRole('button', { name: /colour/i })
    if (await colorBtn.count()) {
      await colorBtn.click()
      await window.waitForTimeout(300)
      await shot(window, 'd12-color-button-no-selection')
    }
    const iconBtn = window.getByRole('button', { name: /^character icon/i })
    if (await iconBtn.count()) {
      await iconBtn.click()
      await window.waitForTimeout(300)
      await shot(window, 'd13-iconbutton-no-selection')
    }
    const collapseBtn = window.getByRole('button', { name: /^collapse/i })
    if (await collapseBtn.count()) {
      await collapseBtn.click()
      await window.waitForTimeout(300)
      await shot(window, 'd14-collapse-button-no-selection')
    }

    // Switch to logs and explore harder
    const logsTab = window.getByRole('tab', { name: /logs/i })
    await logsTab.click()
    await window.waitForTimeout(800)
    await shot(window, 'd15-logs-mode')

    const partnerList = window.getByTestId('partner-list')
    const partners = partnerList.locator('li button')
    const partnerCount = await partners.count()
    observations['log-partner-count'] = partnerCount

    // Get all partner labels including channels
    const allLabels: string[] = []
    for (let i = 0; i < partnerCount; i++) {
      const l = await partners.nth(i).locator('.label').textContent().catch(() => '')
      allLabels.push((l || '').trim())
    }
    observations['log-all-partner-labels'] = allLabels

    // Click first channel (starts with #)
    let channelIdx = -1
    let nonChannelIdx = -1
    for (let i = 0; i < allLabels.length; i++) {
      if (allLabels[i].startsWith('#') && channelIdx < 0) channelIdx = i
      if (!allLabels[i].startsWith('#') && nonChannelIdx < 0) nonChannelIdx = i
    }
    if (channelIdx >= 0) {
      await partners.nth(channelIdx).click()
      await window.waitForTimeout(1500)
      await shot(window, 'd16-channel-clicked')
      const channelHasBody = await window.getByTestId('log-body').isVisible().catch(() => false)
      observations['channel-log-body-visible'] = channelHasBody
      // Check for any error/empty message
      const channelBodyText = await window.getByTestId('log-body').textContent().catch(() => '<missing>')
      observations['channel-log-body-text'] = (channelBodyText || '').slice(0, 200)
    }

    // Click a non-channel partner
    if (nonChannelIdx >= 0) {
      await partners.nth(nonChannelIdx).click()
      await window.waitForTimeout(2000)
      await shot(window, 'd17-partner-conversation', true)
      const logBody = window.getByTestId('log-body')
      const msgCount = await logBody.locator('.log-msg').count()
      observations['partner-msg-count'] = msgCount
      const firstMsgText = (await logBody.locator('.log-msg').first().textContent()) || ''
      observations['partner-first-msg-text-len'] = firstMsgText.length

      // Look at IC/OOC pills more carefully
      const pills = window.locator('.log-pill')
      const pillCount = await pills.count()
      observations['log-pill-count'] = pillCount
      // Click each pill to test toggle
      for (let i = 0; i < Math.min(pillCount, 3); i++) {
        const p = pills.nth(i)
        const labelBefore = await p.textContent()
        const ariaPressed = await p.getAttribute('aria-pressed')
        observations[`pill-${i}-label`] = (labelBefore || '').trim()
        observations[`pill-${i}-aria-pressed-before`] = ariaPressed
        await p.click()
        await window.waitForTimeout(400)
        const ariaAfter = await p.getAttribute('aria-pressed')
        observations[`pill-${i}-aria-pressed-after`] = ariaAfter
        const msgAfter = await logBody.locator('.log-msg').count()
        observations[`pill-${i}-msg-count-after-click`] = msgAfter
      }
      await shot(window, 'd18-after-pill-toggles')

      // Reset pills by clicking again
      for (let i = 0; i < Math.min(pillCount, 3); i++) {
        await pills.nth(i).click()
        await window.waitForTimeout(200)
      }

      // Search box behaviour: full-text vs no-results
      const searchBox = window.locator('input[type="search"], input[placeholder*="earch" i]').first()
      const sCount = await searchBox.count()
      observations['search-box-count'] = sCount
      if (sCount) {
        const placeholder = await searchBox.getAttribute('placeholder')
        observations['search-placeholder'] = placeholder
        // search for a token that should exist
        await searchBox.fill('the')
        await window.waitForTimeout(800)
        const afterSearch = await logBody.locator('.log-msg').count()
        observations['search-the-count'] = afterSearch
        await shot(window, 'd19-search-the')
        // search for nonsense
        await searchBox.fill('xyzqqqq')
        await window.waitForTimeout(800)
        const afterNoSearch = await logBody.locator('.log-msg').count()
        observations['search-noresult-count'] = afterNoSearch
        await shot(window, 'd20-search-no-results')
        // empty
        await searchBox.fill('')
        await window.waitForTimeout(400)
      }
    }

    // Switching characters via dropdown
    const charPicker = window.getByTestId('char-picker')
    const pickerCount = await charPicker.count()
    observations['char-picker-count'] = pickerCount
    if (pickerCount) {
      await charPicker.click()
      await window.waitForTimeout(500)
      await shot(window, 'd21-char-picker-open')
      // What does the popup look like? Inspect.
      const dropdownItems = await window.locator('[role="option"], .char-picker-item, [class*="picker"] li, [class*="picker"] button').count()
      observations['char-picker-dropdown-items'] = dropdownItems

      // Close dropdown
      await window.keyboard.press('Escape')
      await window.waitForTimeout(200)
    }

    // Test the editor mode tab again, see if logs disappear/clear
    await window.getByRole('tab', { name: /editor/i }).click()
    await window.waitForTimeout(500)
    await shot(window, 'd22-back-to-editor')

    // Empty input fetch — error feedback?
    await fetchInput.fill('')
    await fetchButton.click()
    await window.waitForTimeout(800)
    await shot(window, 'd23-empty-fetch')
    const errorAfterEmpty = await window.evaluate(() => document.body.innerText)
    observations['empty-fetch-page-has-error'] = /error|fail|required|invalid/i.test(errorAfterEmpty)

    // Weird chars
    await fetchInput.fill('!!! @@@ /// nope')
    await fetchButton.click()
    await window.waitForTimeout(3000)
    await shot(window, 'd24-junk-fetch')

    // Switch logs<->editor multiple times to check stability
    await window.getByRole('tab', { name: /logs/i }).click()
    await window.waitForTimeout(300)
    await window.getByRole('tab', { name: /editor/i }).click()
    await window.waitForTimeout(300)
    await window.getByRole('tab', { name: /logs/i }).click()
    await window.waitForTimeout(300)
    await window.getByRole('tab', { name: /editor/i }).click()
    await window.waitForTimeout(300)
    await shot(window, 'd25-after-tab-thrash')

    // Window resize behaviour
    await window.setViewportSize({ width: 700, height: 600 })
    await window.waitForTimeout(400)
    await shot(window, 'd26-narrow-viewport')
    await window.setViewportSize({ width: 1400, height: 900 })
    await window.waitForTimeout(400)
  } finally {
    await writeFile(resolve(OUT, 'observations2.json'), JSON.stringify(observations, null, 2))
    await app.close()
  }
})
