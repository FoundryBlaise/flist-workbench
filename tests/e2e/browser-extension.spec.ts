import { test, expect } from '@playwright/test'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { menuAction, withApp } from './launch'

// Needs `npm run fetch:extension` first: the dev build reads the
// extension from resources/browser-extension, same as a packed build
// reads it from its resources folder.
test('Settings hands over the bundled browser extension', async () => {
  const bundled = resolve(__dirname, '../../resources/browser-extension/manifest.json')
  test.skip(!existsSync(bundled), 'run `npm run fetch:extension` first')
  const version = JSON.parse(await readFile(bundled, 'utf8')).version as string

  await withApp(async ({ app, window, userData }) => {
    // Help -> Install Browser Extension lands straight on Security.
    await menuAction(app, 'install-browser-extension')

    await expect(window.getByTestId('settings-extension-version')).toContainText(
      `Version ${version} included with this app`
    )
    // The folder Chrome is pointed at lives in userData, not in the
    // app's own files, and holds the bundled release.
    const shown = resolve(userData, 'browser-extension')
    await expect(window.getByTestId('settings-extension-path')).toHaveValue(shown)
    const copied = JSON.parse(await readFile(resolve(shown, 'manifest.json'), 'utf8'))
    expect(copied.version).toBe(version)
  })
})
