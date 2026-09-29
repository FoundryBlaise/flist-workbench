import { test, expect, _electron as electron } from '@playwright/test'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

// Needs `npm run fetch:extension` first: the dev build reads the
// extension from resources/browser-extension, same as a packed build
// reads it from its resources folder.
test('Settings hands over the bundled browser extension', async () => {
  const root = resolve(__dirname, '../..')
  const bundled = resolve(root, 'resources/browser-extension/manifest.json')
  test.skip(!existsSync(bundled), 'run `npm run fetch:extension` first')
  const version = JSON.parse(await readFile(bundled, 'utf8')).version as string

  const dataDir = await mkdtemp(resolve(tmpdir(), 'flist-wb-ext-data-'))
  const userData = await mkdtemp(resolve(tmpdir(), 'flist-wb-ext-userdata-'))
  const app = await electron.launch({
    args: [resolve(root, 'out/main/main.js'), `--user-data-dir=${userData}`],
    cwd: root,
    env: { ...process.env, NODE_ENV: 'test', FLIST_WORKBENCH_DATA_DIR: dataDir }
  })

  try {
    // Dev builds open a detached DevTools window too; skip past it.
    let window = app.windows().find((w) => !w.url().startsWith('devtools://'))
    while (!window) {
      const w = await app.waitForEvent('window')
      if (!w.url().startsWith('devtools://')) window = w
    }
    await expect(window.getByTestId('sidecar-status')).toContainText('ok')
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('menu:action', 'settings')
    })
    await window.getByTestId('settings-rail-security').click()

    await expect(window.getByTestId('settings-extension-version')).toContainText(
      `Version ${version} included with this app`
    )
    // The folder Chrome is pointed at lives in userData, not in the
    // app's own files, and holds the bundled release.
    const shown = resolve(userData, 'browser-extension')
    await expect(window.getByTestId('settings-extension-path')).toHaveValue(shown)
    const copied = JSON.parse(await readFile(resolve(shown, 'manifest.json'), 'utf8'))
    expect(copied.version).toBe(version)
    await window.screenshot({ path: resolve(__dirname, '../screenshots/settings-extension.png') })
  } finally {
    await app.close()
  }
})
