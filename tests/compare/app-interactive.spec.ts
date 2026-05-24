import { test, expect, _electron as electron } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const OUT = resolve(__dirname, 'artifacts')

// Boots the real Electron app, loads Lady Amber Blaise via the sidecar,
// then exercises the preview interactively: click a collapse to expand,
// verify the body is visible (no pip-out, but also no longer empty),
// and confirm an [img=ID] resolves to a real CDN url because the
// inlines manifest came down with the profile.
test('lady amber blaise: collapse expands and inline images render', async () => {
  await mkdir(OUT, { recursive: true })
  const root = resolve(__dirname, '../..')
  const app = await electron.launch({
    args: [resolve(root, 'out/main/main.js')],
    cwd: root,
    env: { ...process.env, NODE_ENV: 'test' }
  })

  try {
    const window = await app.firstWindow()
    await expect(window.getByTestId('sidecar-status')).toContainText('ok')

    await window.getByTestId('profile-fetch-input').fill('Lady Amber Blaise')
    await window.getByRole('button', { name: /fetch profile/i }).click()
    await expect(window.locator('.doc-name')).toContainText('Lady Amber Blaise.bbcode', {
      timeout: 15_000
    })
    const preview = window.getByTestId('preview-body')
    await expect(preview).toBeVisible()

    // Inline images must use the hashed charinline URL pattern.
    // The first inline in the profile is id=3465484, hash 709932…
    const inlineImg = preview.locator('img.bb-img').first()
    await expect(inlineImg).toBeVisible({ timeout: 10_000 })
    const src = await inlineImg.getAttribute('src')
    expect(src).toContain('/images/charinline/')
    expect(src).not.toContain('/images/charimage/')

    // Open the first collapse and confirm its body becomes visible —
    // and STAYS visible after focus moves elsewhere. The previous bug
    // was: click → opens → focus event triggers re-render → loses
    // details.open → user has to click twice.
    const firstCollapse = preview.locator('details.bb-collapse').first()
    await expect(firstCollapse).toBeVisible()
    const body = firstCollapse.locator('.bb-collapse-body')
    await expect(body).toBeHidden()  // closed by default
    await firstCollapse.locator('summary.bb-collapse-header').click()
    await expect(body).toBeVisible()
    // Click somewhere outside the preview pane to trigger blur, then
    // verify the collapse stayed open instead of getting reset.
    await window.locator('.editor-toolbar').first().click()
    await expect(body).toBeVisible()

    // Body must be inside the details bounding box.
    const within = await firstCollapse.evaluate((d) => {
      const dRect = d.getBoundingClientRect()
      const b = d.querySelector<HTMLElement>('.bb-collapse-body')!.getBoundingClientRect()
      return b.left >= dRect.left - 1 && b.right <= dRect.right + 1
    })
    expect(within).toBe(true)

    // Scroll the preview to where an inline image renders so the
    // screenshot proves the character art comes back from the CDN.
    await preview.evaluate((el) => {
      const img = el.querySelector('img.bb-img')
      img?.scrollIntoView({ block: 'center' })
    })
    await window.screenshot({ path: resolve(OUT, 'app-lady-amber-blaise.png'), fullPage: false })
  } finally {
    await app.close()
  }
})
