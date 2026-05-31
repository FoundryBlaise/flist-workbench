import { test, expect, _electron as electron } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const OUT = resolve(__dirname, 'artifacts')

// Skipped: Fetch Profile UI removed — re-enable if the button comes back.
test.skip('polish: shortcut bold, picker filter, image lightbox, friendlier 404', async () => {
  await mkdir(OUT, { recursive: true })
  const root = resolve(__dirname, '../..')
  const app = await electron.launch({
    args: [resolve(root, 'out/main/main.js')],
    cwd: root,
    env: { ...process.env, NODE_ENV: 'test' }
  })

  try {
    const w = await app.firstWindow()
    await expect(w.getByTestId('sidecar-status')).toContainText('ok')

    // 1. Keyboard shortcut wraps the selection with [b][/b].
    const editor = w.getByTestId('editor-cm').locator('.cm-content')
    await editor.click()
    await w.keyboard.press('ControlOrMeta+A')
    await w.keyboard.type('hello world')
    await w.keyboard.press('ControlOrMeta+A')
    await w.keyboard.press('ControlOrMeta+b')
    await expect(editor).toContainText('[b]hello world[/b]')

    // Toolbar tooltip now contains the shortcut hint (Ctrl+B on linux).
    const boldBtn = w.getByRole('button', { name: /^Bold/ })
    await expect(boldBtn).toHaveAttribute('title', /Ctrl\+B|⌘B/)

    // 2. Character picker has a typeahead filter.
    const picker = w.getByTestId('char-picker')
    await picker.locator('button.char-picker').click()
    const search = w.getByPlaceholder('Filter characters…')
    await expect(search).toBeFocused()
    await search.fill('azure')
    // Only Azure Viper should be visible (case-insensitive match).
    const menu = w.locator('.char-picker-menu ul')
    await expect(menu.locator('li button')).toHaveCount(1)
    await expect(menu.locator('li button').first()).toContainText('Azure Viper')
    // Picker entries are now title-cased even though the disk name is lower.
    await search.press('Escape')

    // 3. Fetch Lady Amber Blaise (uses the manifest path), then click an
    //    inline image — lightbox must open and contain the same src.
    await w.getByTestId('profile-fetch-input').fill('Lady Amber Blaise')
    await w.getByRole('button', { name: /fetch profile/i }).click()
    await expect(w.locator('.doc-name')).toContainText('Lady Amber Blaise.bbcode', {
      timeout: 15_000
    })
    const preview = w.getByTestId('preview-body')
    const firstImg = preview.locator('img.bb-img').first()
    await expect(firstImg).toBeVisible({ timeout: 10_000 })
    const src = await firstImg.getAttribute('src')
    expect(src).toContain('/images/charinline/')
    // cursor:zoom-in advertises the affordance.
    const cursor = await firstImg.evaluate((el) => getComputedStyle(el).cursor)
    expect(cursor).toBe('zoom-in')
    await firstImg.click()
    const lightbox = w.getByTestId('bb-lightbox')
    await expect(lightbox).toBeVisible()
    await expect(lightbox.locator('img')).toHaveAttribute('src', src!)
    await w.screenshot({ path: resolve(OUT, 'lightbox-open.png') })
    // Escape closes the lightbox.
    await w.keyboard.press('Escape')
    await expect(lightbox).toBeHidden()

    // 4. Friendlier 404 message — no raw "HTTP 404" leaking.
    await w.getByTestId('profile-fetch-input').fill('xyz-does-not-exist-zzz')
    await w.getByRole('button', { name: /fetch profile/i }).click()
    await expect(w.locator('.editor-error')).toContainText(
      /No character named .*xyz-does-not-exist-zzz/i,
      { timeout: 15_000 }
    )
    await expect(w.locator('.editor-error')).not.toContainText('HTTP 404')
  } finally {
    await app.close()
  }
})
