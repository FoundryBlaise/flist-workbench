import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'

export type LaunchedApp = {
  app: ElectronApplication
  window: Page
  /** The app's own data folder (FLIST_WORKBENCH_DATA_DIR), fresh per launch. */
  dataDir: string
  /** Electron's userData folder, fresh per launch. */
  userData: string
  /** What the app sees as %APPDATA%, fresh and empty per launch. */
  appData: string
  /** The fixture F-Chat folder built in global setup. */
  fchatDir: string
}

function e2eEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is unset; run the e2e suite through playwright.config.ts`)
  return value
}

// A port nothing listens on, so the app's sidecar can never collide
// with (or be mistaken for) a sidecar the developer has running on the
// default port against their real data.
async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() =>
        typeof address === 'object' && address ? resolvePort(address.port) : reject(new Error('no port'))
      )
    })
  })
}

/**
 * Starts the built app against a fresh temporary data folder and the
 * fixture F-Chat folder, never against the user's own data:
 * - FLIST_WORKBENCH_DATA_DIR, Electron's userData and APPDATA all
 *   point into a new folder under the run's temp root, so even a
 *   default-path fallback lands somewhere empty;
 * - the sidecar runs on a free port of its own;
 * - the OS credential store is off, so no saved F-list login is read;
 * - the eicon warm-up, the one network call at startup, is skipped.
 *
 * `pinFchatDir: false` leaves FCHAT_DATA_DIR unset so the Settings
 * value drives the F-Chat folder; it then defaults into the empty
 * temp APPDATA.
 */
export async function launchApp(
  opts: { pinFchatDir?: boolean } = {}
): Promise<LaunchedApp> {
  const root = resolve(__dirname, '../..')
  const fchatDir = e2eEnv('FLIST_WB_E2E_FCHAT_DIR')
  const run = await mkdtemp(join(e2eEnv('FLIST_WB_E2E_ROOT'), 'run-'))
  const dataDir = join(run, 'data')
  const userData = join(run, 'userdata')
  const appData = join(run, 'appdata')
  await Promise.all([dataDir, userData, appData].map((d) => mkdir(d)))

  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  // ELECTRON_RUN_AS_NODE leaks in from editor terminals (VS Code sets
  // it) and turns electron.exe into plain node.
  for (const k of ['FCHAT_DATA_DIR', 'SIDECAR_PORT', 'ELECTRON_RENDERER_URL', 'ELECTRON_RUN_AS_NODE'])
    delete env[k]
  Object.assign(env, {
    NODE_ENV: 'test',
    FLIST_WORKBENCH_DATA_DIR: dataDir,
    APPDATA: appData,
    SIDECAR_PORT: String(await freePort()),
    FLIST_WORKBENCH_NO_KEYCHAIN: '1',
    FLIST_WORKBENCH_OFFLINE_STARTUP: '1'
  })
  if (opts.pinFchatDir !== false) env['FCHAT_DATA_DIR'] = fchatDir

  const app = await electron.launch({
    args: [resolve(root, 'out/main/main.js'), `--user-data-dir=${userData}`],
    cwd: root,
    env
  })

  // Dev builds open a detached DevTools window too; skip past it.
  let window = app.windows().find((w) => !w.url().startsWith('devtools://'))
  while (!window) {
    const w = await app.waitForEvent('window')
    if (!w.url().startsWith('devtools://')) window = w
  }
  window.on('dialog', (d) => void d.accept())
  await expect(window.getByTestId('sidecar-status')).toContainText('ok')

  // With no saved login the app always opens the F-list sign-in on
  // start. The suite never signs in; close it so it does not sit over
  // the modal under test.
  const signIn = window.locator('.flist-signin-modal')
  await expect(signIn).toBeVisible()
  await signIn.getByRole('button', { name: 'Close' }).click()
  await expect(signIn).toBeHidden()
  return { app, window, dataDir, userData, appData, fchatDir }
}

/** Sends a native-menu action the way the menu item does. */
export async function menuAction(app: ElectronApplication, action: string): Promise<void> {
  await app.evaluate(({ BrowserWindow }, a) => {
    BrowserWindow.getAllWindows()
      .find((w) => !w.webContents.getURL().startsWith('devtools://'))
      ?.webContents.send('menu:action', a)
  }, action)
}
