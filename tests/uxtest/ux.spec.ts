import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const OUT = resolve(__dirname, 'artifacts')

// Lightweight observation log so the report can quote concrete numbers/text.
const observations: Record<string, unknown> = {}

async function shot(window: Page, name: string, fullPage = false) {
  await window.screenshot({ path: resolve(OUT, `${name}.png`), fullPage })
}

async function dump(name: string, value: unknown) {
  observations[name] = value
}

// Skipped: Fetch Profile UI removed — re-enable if the button comes back.
test.skip('ux walkthrough', async () => {
  await mkdir(OUT, { recursive: true })
  const root = resolve(__dirname, '../..')

  const app: ElectronApplication = await electron.launch({
    args: [resolve(root, 'out/main/main.js')],
    cwd: root,
    env: { ...process.env, NODE_ENV: 'test' }
  })

  const window = await app.firstWindow()
  // give renderer time to settle
  await window.waitForLoadState('domcontentloaded')

  try {
    // ---- 1. First impression — what's on screen before clicking? ----
    await window.waitForTimeout(2000)
    await shot(window, '01-first-impression-immediate')

    // Capture title and headings to see what greets the user.
    const title = await window.title().catch(() => '<no title>')
    await dump('window-title', title)

    const visibleText = await window.evaluate(() => document.body.innerText.slice(0, 1500))
    await dump('initial-visible-text', visibleText)

    // Wait for sidecar to mark ok (or fail visibly)
    const sidecarStatus = window.getByTestId('sidecar-status')
    let sidecarTextEarly = '<missing>'
    try {
      sidecarTextEarly = (await sidecarStatus.textContent({ timeout: 4000 })) || '<empty>'
    } catch {
      sidecarTextEarly = '<not found in DOM>'
    }
    await dump('sidecar-status-early', sidecarTextEarly)

    // Wait a bit more for sidecar to come online.
    try {
      await expect(sidecarStatus).toContainText('ok', { timeout: 30_000 })
    } catch {
      // not blocking
    }
    const sidecarTextLate = await sidecarStatus.textContent().catch(() => '<missing>')
    await dump('sidecar-status-after-wait', sidecarTextLate)
    await shot(window, '02-after-sidecar-ready')

    // ---- 2. Fetch profile: Azure Viper ----
    const fetchInput = window.getByTestId('profile-fetch-input')
    const fetchButton = window.getByRole('button', { name: /fetch profile/i })

    const inputExists = await fetchInput.count()
    const buttonExists = await fetchButton.count()
    await dump('fetch-affordance-input-count', inputExists)
    await dump('fetch-affordance-button-count', buttonExists)

    await fetchInput.fill('Azure Viper')
    await shot(window, '03-azure-viper-typed')

    const fetchStart = Date.now()
    await fetchButton.click()

    // Did the button reflect "loading"? Capture immediately.
    await window.waitForTimeout(120)
    await shot(window, '04-azure-viper-just-after-click')
    const btnLabelDuring = await fetchButton.textContent().catch(() => '<none>')
    await dump('fetch-button-label-during-load', btnLabelDuring)

    // Wait for the document name to switch.
    let azureLoaded = false
    try {
      await expect(window.locator('.doc-name')).toContainText('Azure Viper.bbcode', { timeout: 30_000 })
      azureLoaded = true
    } catch {
      azureLoaded = false
    }
    const azureLoadMs = Date.now() - fetchStart
    await dump('azure-viper-load-ms', azureLoadMs)
    await dump('azure-viper-loaded', azureLoaded)
    await shot(window, '05-azure-viper-loaded', true)

    // ---- 3. Preview pane ----
    const preview = window.getByTestId('preview-body')
    await expect(preview).toBeVisible()

    // Count collapses, images, structure
    const collapseCount = await preview.locator('details.bb-collapse').count()
    const imgCount = await preview.locator('img').count()
    const headingCount = await preview.locator('.bb-heading').count()
    await dump('preview-collapse-count', collapseCount)
    await dump('preview-image-count', imgCount)
    await dump('preview-heading-count', headingCount)

    // Try clicking the first collapse if present.
    if (collapseCount > 0) {
      const firstCollapse = preview.locator('details.bb-collapse').first()
      const summary = firstCollapse.locator('summary.bb-collapse-header')
      const before = await firstCollapse.evaluate((d: HTMLDetailsElement) => d.open)
      await dump('collapse-open-default', before)
      await summary.click()
      await window.waitForTimeout(300)
      const after = await firstCollapse.evaluate((d: HTMLDetailsElement) => d.open)
      await dump('collapse-open-after-click', after)
      await shot(window, '06-after-collapse-click')

      // Click outside to check if collapse stays open (regression check)
      await window.mouse.click(5, 5)
      await window.waitForTimeout(200)
      const stillOpen = await firstCollapse.evaluate((d: HTMLDetailsElement) => d.open)
      await dump('collapse-open-after-blur', stillOpen)
    }

    // Try clicking an inline image to see what happens
    if (imgCount > 0) {
      const firstImg = preview.locator('img').first()
      await firstImg.scrollIntoViewIfNeeded().catch(() => {})
      const src = await firstImg.getAttribute('src').catch(() => null)
      await dump('first-image-src', src)
      await shot(window, '07-image-in-view')
      // Click it — does anything happen? lightbox?
      const popupBefore = await window.evaluate(() => document.querySelectorAll('dialog, .lightbox, [role=dialog]').length)
      await firstImg.click({ trial: false }).catch(() => {})
      await window.waitForTimeout(500)
      const popupAfter = await window.evaluate(() => document.querySelectorAll('dialog, .lightbox, [role=dialog]').length)
      await dump('image-click-popup-before', popupBefore)
      await dump('image-click-popup-after', popupAfter)
      await shot(window, '08-after-image-click')
    }

    // Selecting text in preview. `globalThis` inside evaluate() is the
    // browser window; the outer `window` is Playwright's Page binding,
    // which TS otherwise treats as the receiver of `.getSelection()`.
    await preview.evaluate((el) => {
      const range = document.createRange()
      const firstText = el.querySelector('p, .bb-heading, div')
      if (firstText && firstText.firstChild) {
        range.selectNodeContents(firstText)
        const sel = globalThis.getSelection()
        sel?.removeAllRanges()
        sel?.addRange(range)
      }
    })
    await window.waitForTimeout(150)
    await shot(window, '09-preview-text-selected')

    // Edit text directly in preview (it's contentEditable)
    await preview.evaluate(() => {
      const span = document.querySelector('[data-testid="preview-body"] [data-bb-start]') as HTMLElement | null
      if (span) {
        span.focus()
        const original = span.textContent
        span.textContent = (original || '') + ' EDITED-IN-PREVIEW'
        span.dispatchEvent(new Event('input', { bubbles: true }))
      }
    })
    await window.waitForTimeout(400)
    await shot(window, '10-after-preview-edit')

    // ---- 4. Editor pane ----
    const editorContent = window.getByTestId('editor-cm').locator('.cm-content')
    await expect(editorContent).toBeVisible()
    const editorTextSnippet = ((await editorContent.textContent()) || '').slice(0, 500)
    await dump('editor-text-snippet', editorTextSnippet)
    await shot(window, '11-editor-pane')

    // Toolbar buttons — list what's there
    const toolbarButtons = await window.locator('.editor-toolbar button').all().catch(async () => {
      return window.locator('[class*="toolbar"] button').all()
    })
    const toolbarLabels: string[] = []
    for (const btn of toolbarButtons) {
      const name = (await btn.getAttribute('aria-label')) || (await btn.textContent()) || '<no label>'
      toolbarLabels.push(name.trim())
    }
    await dump('toolbar-button-labels', toolbarLabels)

    // Use editor: type, click bold
    await editorContent.click()
    await window.keyboard.press('ControlOrMeta+End')
    await window.keyboard.type('\nHello from UX test')
    await window.waitForTimeout(200)
    await shot(window, '12-typed-in-editor')

    // Select what we just typed and click Bold if it exists.
    await window.keyboard.press('Shift+Home')
    const boldBtn = window.getByRole('button', { name: 'Bold' })
    const boldExists = await boldBtn.count()
    if (boldExists) {
      await boldBtn.click()
      await window.waitForTimeout(200)
      await shot(window, '13-after-bold')
    }

    // ---- 5. Switch to Logs mode ----
    const logsTab = window.getByRole('tab', { name: /logs/i })
    const logsTabCount = await logsTab.count()
    await dump('logs-tab-found', logsTabCount)
    if (logsTabCount) {
      await logsTab.click()
      await window.waitForTimeout(800)
      await shot(window, '14-logs-mode-initial', true)

      const partnerList = window.getByTestId('partner-list')
      const partnerListVisible = await partnerList.isVisible().catch(() => false)
      await dump('partner-list-visible', partnerListVisible)

      if (partnerListVisible) {
        const partners = partnerList.locator('li button')
        const partnerCount = await partners.count()
        await dump('partner-count', partnerCount)

        // capture some labels for the report
        const sampleLabels: string[] = []
        for (let i = 0; i < Math.min(6, partnerCount); i++) {
          const l = await partners.nth(i).locator('.label').textContent().catch(() => '<?>')
          sampleLabels.push((l || '<?>').trim())
        }
        await dump('partner-sample-labels', sampleLabels)

        // Click first non-channel partner
        for (let i = 0; i < partnerCount; i++) {
          const label = (await partners.nth(i).locator('.label').textContent()) || ''
          if (!label.startsWith('#')) {
            await partners.nth(i).click()
            break
          }
        }
        await window.waitForTimeout(1500)
        await shot(window, '15-logs-partner-opened', true)

        const logBody = window.getByTestId('log-body')
        const logVisible = await logBody.isVisible().catch(() => false)
        await dump('log-body-visible', logVisible)
        const messageCount = await logBody.locator('.log-msg').count().catch(() => 0)
        await dump('log-message-count', messageCount)

        // Try IC/OOC toggles — find pills
        const pills = await window.locator('.log-pill').all().catch(() => [])
        const pillLabels: string[] = []
        for (const p of pills) {
          const t = await p.textContent()
          pillLabels.push((t || '').trim())
        }
        await dump('log-pill-labels', pillLabels)

        // try clicking an OOC pill if any
        const oocPill = window.locator('.log-pill').filter({ hasText: /OOC/ })
        if (await oocPill.count()) {
          await oocPill.first().click()
          await window.waitForTimeout(400)
          await shot(window, '16-after-ooc-toggle')
          await oocPill.first().click()
          await window.waitForTimeout(200)
        }

        // Try the search box
        const searchBox = window.locator('input[type="search"], input[placeholder*="earch" i]').first()
        if (await searchBox.count()) {
          await searchBox.fill('the')
          await window.waitForTimeout(800)
          await shot(window, '17-log-search-the')
          const filteredCount = await logBody.locator('.log-msg').count().catch(() => 0)
          await dump('log-message-count-after-search', filteredCount)
          await searchBox.fill('')
          await window.waitForTimeout(300)
        } else {
          await dump('log-search-box-found', false)
        }
      }
    }

    // ---- 6. Switch back to editor and load Svenja Lindstroem ----
    const editorTab = window.getByRole('tab', { name: /editor/i })
    if (await editorTab.count()) {
      await editorTab.click()
      await window.waitForTimeout(500)
      await shot(window, '18-back-in-editor-mode')
    }

    // Did the previous editor state survive?
    const editorAfterReturn = ((await editorContent.textContent()) || '').slice(0, 200)
    await dump('editor-text-after-mode-switch', editorAfterReturn)

    // Fetch Svenja Lindstroem (note the oe spelling)
    await fetchInput.fill('Svenja Lindstroem')
    await shot(window, '19-svenja-typed')
    const svenjaStart = Date.now()
    await fetchButton.click()
    let svenjaLoaded = false
    try {
      await expect(window.locator('.doc-name')).toContainText('Svenja Lindstroem.bbcode', { timeout: 30_000 })
      svenjaLoaded = true
    } catch {
      svenjaLoaded = false
    }
    const svenjaLoadMs = Date.now() - svenjaStart
    await dump('svenja-load-ms', svenjaLoadMs)
    await dump('svenja-loaded', svenjaLoaded)
    await shot(window, '20-svenja-loaded', true)

    // Did the prior Azure document survive somewhere or did it overwrite?
    const docNames = await window.locator('.doc-name').allTextContents().catch(() => [])
    await dump('doc-names-after-svenja', docNames)

    // Take a close-up of the preview to inspect rendering
    await preview.evaluate((el) => el.scrollTo({ top: 0 }))
    await shot(window, '21-svenja-preview-top')
    await preview.evaluate((el) => el.scrollTo({ top: 800 }))
    await shot(window, '22-svenja-preview-scrolled')

    // ---- Visual polish — capture focus and hover states ----
    // Tab once to see focus ring
    await window.keyboard.press('Tab')
    await window.waitForTimeout(150)
    await shot(window, '23-after-tab-focus')

    // Hover over the fetch button
    await fetchButton.hover()
    await window.waitForTimeout(150)
    await shot(window, '24-fetch-button-hover')

    // Try a bogus profile name to see error handling
    await fetchInput.fill('zzz-not-a-real-character-xyz')
    await fetchButton.click()
    await window.waitForTimeout(4000)
    await shot(window, '25-bogus-profile-error', true)
    const errorText = await window.evaluate(() => document.body.innerText)
    const errLine = (errorText.match(/error|fail|not found|404/i) || [])[0] || '<no obvious error>'
    await dump('bogus-fetch-error-hint', errLine)

    // Empty fetch
    await fetchInput.fill('')
    await fetchButton.click()
    await window.waitForTimeout(800)
    await shot(window, '26-empty-fetch-attempt')

    // Final overall full-page screenshot
    await shot(window, '27-final-state', true)
  } finally {
    // Save observations to a JSON for the report writer to read.
    await writeFile(resolve(OUT, 'observations.json'), JSON.stringify(observations, null, 2))
    await app.close()
  }
})
