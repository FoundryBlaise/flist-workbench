import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'

/**
 * How long the app gets to start: its window open and the sidecar
 * status reading ok. Main opens the window only once the sidecar
 * answers, so on a slow runner both sit in this one budget. It is kept
 * apart from the 15 s each test step gets (playwright.config.ts), so a
 * slow start fails only when the app really doesn't start.
 */
const START_BUDGET_MS = 45_000

/** Lines of the app's diagnostic log attached when the start times out. */
const DIAG_LOG_TAIL_LINES = 200

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
  /** Where this launch's sidecar listens, e.g. `http://127.0.0.1:50123`. */
  sidecarUrl: string
}

export type LaunchOptions = {
  pinFchatDir?: boolean
  /** Start on this data folder instead of a fresh one. */
  dataDir?: string
  /** Extra environment for the app, applied last. */
  env?: Record<string, string>
  /** Run the sidecar on this port instead of a free one: a spec that
   *  put something there first. */
  port?: number
}

function e2eEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is unset; run the e2e suite through playwright.config.ts`)
  return value
}

// A port nothing listens on, so the app's sidecar can never collide
// with (or be mistaken for) a sidecar the developer has running on the
// default port against their real data.
export async function freePort(): Promise<number> {
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
 *
 * `dataDir` starts the app on a data folder an earlier launch (or
 * `seedCharacter`) already wrote, as the user's next start would.
 */
async function launchApp(opts: LaunchOptions = {}): Promise<LaunchedApp> {
  const root = resolve(__dirname, '../..')
  const fchatDir = e2eEnv('FLIST_WB_E2E_FCHAT_DIR')
  const run = await mkdtemp(join(e2eEnv('FLIST_WB_E2E_ROOT'), 'run-'))
  const dataDir = opts.dataDir ?? join(run, 'data')
  const userData = join(run, 'userdata')
  const appData = join(run, 'appdata')
  await Promise.all([dataDir, userData, appData].map((d) => mkdir(d, { recursive: true })))

  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  // ELECTRON_RUN_AS_NODE leaks in from editor terminals (VS Code sets
  // it) and turns electron.exe into plain node.
  // PORTABLE_EXECUTABLE_DIR and FLIST_WORKBENCH_UPDATE_FEED are set
  // only by the spec that asks for them (opts.env).
  for (const k of [
    'FCHAT_DATA_DIR',
    'SIDECAR_PORT',
    'ELECTRON_RENDERER_URL',
    'ELECTRON_RUN_AS_NODE',
    'PORTABLE_EXECUTABLE_DIR',
    'FLIST_WORKBENCH_UPDATE_FEED'
  ])
    delete env[k]
  const port = opts.port ?? (await freePort())
  Object.assign(env, {
    NODE_ENV: 'test',
    FLIST_WORKBENCH_DATA_DIR: dataDir,
    APPDATA: appData,
    SIDECAR_PORT: String(port),
    FLIST_WORKBENCH_NO_KEYCHAIN: '1',
    FLIST_WORKBENCH_OFFLINE_STARTUP: '1',
    // Show the window without taking the focus from the user's desktop.
    FLIST_WORKBENCH_NO_FOCUS: '1'
  })
  if (opts.pinFchatDir !== false) env['FCHAT_DATA_DIR'] = fchatDir
  Object.assign(env, opts.env)

  const app = await electron.launch({
    args: [resolve(root, 'out/main/main.js'), `--user-data-dir=${userData}`],
    cwd: root,
    env
  })

  const window = await waitForStart(app, userData)

  // With no saved login the app always opens the F-list sign-in on
  // start. The suite never signs in; close it so it does not sit over
  // the modal under test.
  const signIn = window.locator('.flist-signin-modal')
  await expect(signIn).toBeVisible()
  await signIn.getByRole('button', { name: 'Close' }).click()
  await expect(signIn).toBeHidden()
  return { app, window, dataDir, userData, appData, fchatDir, sidecarUrl: `http://127.0.0.1:${port}` }
}

/**
 * Launches the app as `launchApp` does, runs `body` against it and
 * closes it. When `body` fails, a screenshot of the window is attached
 * to the test (saved in its test-results folder) before the error is
 * passed on; a passing run writes no screenshots.
 */
export async function withApp(
  body: (launched: LaunchedApp) => Promise<void>,
  opts: LaunchOptions = {}
): Promise<void> {
  const launched = await launchApp(opts)
  try {
    await body(launched)
  } catch (error) {
    await attachScreenshot(launched.window)
    throw error
  } finally {
    await launched.app.close()
  }
}

/**
 * Waits, within START_BUDGET_MS, for the app's window to open and its
 * sidecar status to read ok. When the start times out, the app is
 * closed and the failure carries a screenshot of the window (if one
 * opened) and the tail of the app's diagnostic log, so a slow start
 * can be told apart from a broken renderer.
 */
async function waitForStart(app: ElectronApplication, userData: string): Promise<Page> {
  const deadline = Date.now() + START_BUDGET_MS
  const left = (): number => Math.max(1, deadline - Date.now())
  let window: Page | undefined
  try {
    // Dev builds open a detached DevTools window too; skip past it.
    window = app.windows().find(isAppWindow)
    while (!window) {
      const w = await app.waitForEvent('window', { timeout: left() })
      if (isAppWindow(w)) window = w
    }
    window.on('dialog', (d) => void d.accept())
    await expect(window.getByTestId('sidecar-status')).toContainText('ok', { timeout: left() })
    return window
  } catch (error) {
    window ??= app.windows().find(isAppWindow)
    if (window) await attachScreenshot(window, 'window at start timeout', 'start-timeout.png')
    // Closed before the log is read, so the log also holds how the
    // app and its sidecar shut down.
    await app.close().catch(() => undefined)
    await attachDiagLogTail(userData)
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(
      `the app did not start within ${START_BUDGET_MS / 1000} s ` +
        `(${window ? 'sidecar status never read ok' : 'no window opened'}); ` +
        `see the attached screenshot and diagnostic log\n\n${reason}`,
      { cause: error }
    )
  }
}

async function attachScreenshot(
  window: Page,
  name = 'window at failure',
  file = 'failure.png'
): Promise<void> {
  try {
    // Written to disk, not attached as a body: the list reporter keeps
    // a body in memory only, and CI uploads test-results/ on failure.
    const path = test.info().outputPath(file)
    await window.screenshot({ path })
    await test.info().attach(name, { path, contentType: 'image/png' })
  } catch {
    // A window too broken to photograph must not hide the real error.
  }
}

/** Attaches the last lines of main-diag.log, which main and the sidecar launcher write. */
async function attachDiagLogTail(userData: string): Promise<void> {
  const log = join(userData, 'main-diag.log')
  let tail: string
  try {
    const lines = (await readFile(log, 'utf8')).trimEnd().split('\n')
    tail = lines.slice(-DIAG_LOG_TAIL_LINES).join('\n') + '\n'
  } catch (error) {
    tail = `(no diagnostic log at ${log}: ${error instanceof Error ? error.message : String(error)})\n`
  }
  try {
    const path = test.info().outputPath('main-diag-tail.log')
    await writeFile(path, tail)
    await test.info().attach('app diagnostic log (tail)', { path, contentType: 'text/plain' })
  } catch {
    // Must not hide the real error either.
  }
}

/**
 * A fresh data folder holding one pulled character, `name`, whose Live
 * description is `description`. Written by the sidecar's own archive
 * code through its venv python, as global setup writes the Logs. Pass
 * the folder to `withApp` as `dataDir`.
 */
export async function seedCharacter(id: string, name: string, description: string): Promise<string> {
  const repo = resolve(__dirname, '../..')
  const python =
    process.platform === 'win32'
      ? join(repo, 'sidecar', '.venv', 'Scripts', 'python.exe')
      : join(repo, 'sidecar', '.venv', 'bin', 'python')
  const dataDir = join(await mkdtemp(join(e2eEnv('FLIST_WB_E2E_ROOT'), 'seed-')), 'data')
  await mkdir(dataDir)
  execFileSync(python, [join(__dirname, 'fixtures', 'seed_character.py'), dataDir, id, name, description], {
    stdio: 'inherit',
    // No console window that takes the focus (see global-setup.ts).
    windowsHide: true
  })
  return dataDir
}

/** Whether a window is the app's own, not the dev build's DevTools. */
function isAppWindow(window: Page): boolean {
  return !window.url().startsWith('devtools://')
}

/** Sends a native-menu action the way the menu item does. */
export async function menuAction(app: ElectronApplication, action: string): Promise<void> {
  const window = app.windows().find(isAppWindow)
  if (!window) throw new Error('the app has no window open')
  const browserWindow = await app.browserWindow(window)
  await browserWindow.evaluate((w, a) => w.webContents.send('menu:action', a), action)
}
