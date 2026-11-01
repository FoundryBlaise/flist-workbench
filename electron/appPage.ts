import { app, net, protocol } from 'electron'
import { stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

// The app's own page: the one page the app window ever shows, and the
// only page whose requests get the launch secret (ADR 0002). Dev loads
// it from the dev server; the built app loads it from its own scheme,
// `app://workbench`, which gives the window an origin no other page
// has. This is the one place that says where it lives.
const APP_SCHEME = 'app'
const APP_HOST = 'workbench'

/** The built renderer's files: inside app.asar once packaged. */
const rendererRoot = resolve(__dirname, '../renderer')

const devServerUrl = app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL']

export const APP_PAGE_URL = devServerUrl ?? `${APP_SCHEME}://${APP_HOST}/index.html`

/**
 * The dev server's origin when the page loads from it, which the
 * sidecar then has to grant as well; undefined in the built app.
 */
export const DEV_SERVER_ORIGIN = devServerUrl === undefined ? undefined : new URL(devServerUrl).origin

const appPage = new URL(APP_PAGE_URL)

/**
 * Whether `url` shows the app's own page. The page owns its whole
 * scheme and host, so any path, query or hash there is the app.
 * Compared by protocol and host, not `URL.origin`: Node reports the
 * origin of an `app:` URL as "null".
 */
export function isAppPage(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return parsed.protocol === appPage.protocol && parsed.host === appPage.host
}

/**
 * Makes `app:` a standard, secure scheme that fetch() works on, so the
 * page gets a real origin and the sidecar can tell it apart. Electron
 * accepts this only before the app is ready.
 */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }
  ])
}

/** Serves `app://workbench/...` from the built renderer. Call once the app is ready. */
export function serveAppScheme(): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const file = await rendererFile(request.url)
    if (file === null) return new Response('Not found', { status: 404 })
    return net.fetch(pathToFileURL(file).href)
  })
}

/**
 * The renderer file `url` names, or null for anything else: another
 * host, a folder, a file that doesn't exist, or a path that leaves the
 * renderer's files once its escapes (`%2e%2e`, `%2f`, `%5c`) are decoded.
 */
async function rendererFile(url: string): Promise<string | null> {
  let parsed: URL
  let path: string
  try {
    parsed = new URL(url)
    path = decodeURIComponent(parsed.pathname)
  } catch {
    return null
  }
  if (parsed.host !== APP_HOST || path.includes('\0')) return null
  const file = join(rendererRoot, path)
  const inside = relative(rendererRoot, file)
  if (inside === '' || isAbsolute(inside) || inside.split(sep)[0] === '..') return null
  try {
    return (await stat(file)).isFile() ? file : null
  } catch {
    return null
  }
}
