import { app } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// The app's own page: the one page the app window ever shows, and the
// only page whose requests get the launch secret (ADR 0002). Dev loads
// it from the dev server; the built app loads it from its files. This
// is the one place that says where it lives.
const devServerUrl = app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL']

export const APP_PAGE_URL =
  devServerUrl ?? pathToFileURL(join(__dirname, '../renderer/index.html')).href

const appPage = new URL(APP_PAGE_URL)

/**
 * Whether `url` shows the app's own page. A served page owns its whole
 * scheme and host, so any path, query or hash there is the app. A
 * file: page shares its "origin" with every file on the disk, so there
 * only the page's own file counts.
 */
export function isAppPage(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== appPage.protocol || parsed.host !== appPage.host) return false
  return appPage.protocol !== 'file:' || parsed.pathname === appPage.pathname
}
