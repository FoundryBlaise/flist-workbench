import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { autoUpdater } from 'electron-updater'
import { startSidecar, stopSidecar, sidecarUrl } from './sidecar'
import { buildMenu } from './menu'
import { attachContextMenu } from './contextMenu'

// Lazy keytar handle. We deliberately do NOT `import keytar` at the top
// of the module: keytar is a native binding, and a load failure (ABI
// mismatch, missing .node binary, sandboxing) at module-evaluation
// time would crash the entire main process before app.whenReady() ever
// fires — i.e. silent "window never opens" with the user seeing only
// "start electron app..." in the terminal. Loading it lazily means a
// broken keychain degrades gracefully: saved-creds features fail, the
// rest of the app keeps working, and the error surfaces in console.
type Keytar = typeof import('keytar')
let _keytar: Keytar | null = null
let _keytarLoadError: string | null = null
function loadKeytar(): Keytar | null {
  if (_keytar) return _keytar
  if (_keytarLoadError) return null
  try {
    _keytar = require('keytar') as Keytar
    return _keytar
  } catch (err) {
    _keytarLoadError = err instanceof Error ? err.message : String(err)
    console.error('[main] keytar load failed:', _keytarLoadError)
    return null
  }
}

const isDev = !app.isPackaged

let mainWindow: BrowserWindow | null = null

// Make main-process crashes diagnosable instead of vanishing into a
// silent "window never opened" state. Three knobs:
//   1. process-level error handlers print stack + write to a log file
//      under userData so post-mortem is possible from a packaged build.
//   2. in dev, DevTools auto-opens so the renderer console is visible
//      without having to remember Ctrl+Shift+I.
//   3. renderer crash/unresponsive events also log, so a white window
//      isn't mysterious.
function appendDiagLog(prefix: string, payload: unknown): void {
  const line = `[${new Date().toISOString()}] ${prefix}: ${
    payload instanceof Error
      ? `${payload.message}\n${payload.stack ?? ''}`
      : typeof payload === 'string'
        ? payload
        : JSON.stringify(payload)
  }\n`
  // stderr first so dev terminals see it; file write is best-effort so
  // a logging failure can't itself crash main.
  process.stderr.write(line)
  try {
    const userData = app.getPath('userData')
    void writeFile(join(userData, 'main-diag.log'), line, { flag: 'a' })
  } catch {
    // No-op
  }
}

process.on('uncaughtException', (err) => {
  appendDiagLog('uncaughtException', err)
})
process.on('unhandledRejection', (reason) => {
  appendDiagLog('unhandledRejection', reason)
})

// Renderer asks for a folder via this channel — we open the OS-native
// directory picker in the main process and return the absolute path
// (or null when the user cancels). Settings modal uses this to pick
// the F-Chat data directory.
ipcMain.handle('workbench:select-directory', async (event, opts: { title?: string; defaultPath?: string } = {}) => {
  const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
  const result = win
    ? await dialog.showOpenDialog(win, {
        title: opts.title ?? 'Select folder',
        defaultPath: opts.defaultPath,
        properties: ['openDirectory']
      })
    : await dialog.showOpenDialog({
        title: opts.title ?? 'Select folder',
        defaultPath: opts.defaultPath,
        properties: ['openDirectory']
      })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

// Working-set bundle export/import file-dialog plumbing. The renderer
// asks for a path, gets bytes back (for import) or writes bytes out
// (for export). Both handlers verify the sender is the main window's
// WebContents so a stray context can't read or write arbitrary files
// from the user's disk.
type SaveDialogOpts = {
  title?: string
  defaultPath?: string
  filters?: { name: string; extensions: string[] }[]
}
type OpenDialogOpts = SaveDialogOpts

ipcMain.handle(
  'workbench:save-file-dialog',
  async (event, opts: SaveDialogOpts = {}) => {
    if (event.sender !== mainWindow?.webContents) return null
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const result = win
      ? await dialog.showSaveDialog(win, {
          title: opts.title ?? 'Save file',
          defaultPath: opts.defaultPath,
          filters: opts.filters
        })
      : await dialog.showSaveDialog({
          title: opts.title ?? 'Save file',
          defaultPath: opts.defaultPath,
          filters: opts.filters
        })
    if (result.canceled || !result.filePath) return null
    return result.filePath
  }
)

ipcMain.handle(
  'workbench:open-file-dialog',
  async (event, opts: OpenDialogOpts = {}) => {
    if (event.sender !== mainWindow?.webContents) return null
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const result = win
      ? await dialog.showOpenDialog(win, {
          title: opts.title ?? 'Open file',
          defaultPath: opts.defaultPath,
          filters: opts.filters,
          properties: ['openFile']
        })
      : await dialog.showOpenDialog({
          title: opts.title ?? 'Open file',
          defaultPath: opts.defaultPath,
          filters: opts.filters,
          properties: ['openFile']
        })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  }
)

// Read/write bytes for paths the user already picked via the dialogs
// above. We only accept absolute paths so a compromised renderer can't
// trick us with a CWD-relative escape. The path itself isn't validated
// against the dialog's prior return — the user owns the disk; the goal
// here is to keep accidents (e.g. an empty/relative path bug in the
// renderer) from misbehaving, not to sandbox a user who deliberately
// types an absolute path.
ipcMain.handle(
  'workbench:read-file',
  async (event, filePath: string): Promise<Uint8Array | null> => {
    if (event.sender !== mainWindow?.webContents) return null
    if (typeof filePath !== 'string' || !isAbsolute(filePath)) return null
    try {
      const buf = await readFile(filePath)
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    } catch (err) {
      console.error('[main] read-file failed:', err)
      return null
    }
  }
)

ipcMain.handle(
  'workbench:write-file',
  async (event, filePath: string, bytes: Uint8Array): Promise<boolean> => {
    if (event.sender !== mainWindow?.webContents) return false
    if (typeof filePath !== 'string' || !isAbsolute(filePath)) return false
    if (!(bytes instanceof Uint8Array)) return false
    try {
      await writeFile(filePath, bytes)
      return true
    } catch (err) {
      console.error('[main] write-file failed:', err)
      return false
    }
  }
)

// Renderer reports which classify scopes are reachable so the native
// menu can grey out items that would otherwise no-op silently. The
// renderer keeps the canonical state (it knows the active character
// and partner); main just mirrors it onto the menu items.
// The renderer reports a single "is a partner / character selected"
// pair; both classify and ingest items mirror the same flags because
// they share the same "active conversation / character" scoping. If we
// ever need ingest-specific gating (e.g. "disable when no embedding
// model is loaded") it goes in a separate flag — for now they track
// together.
type MenuFlags = {
  classifyCurrent: boolean
  classifyCharacter: boolean
  flistSessionActive: boolean
}
// Wizard-side conveniences. All three accept fixed shapes and have
// strict filtering so a compromised renderer can't smuggle arbitrary
// commands into the host. Each handler also verifies the sender is
// our main window's WebContents — IPC messages from any other source
// (e.g. an unexpected iframe) get dropped without acting.

// Hostnames we'll open in the user's browser. Locked to the two we
// actually need so a compromised renderer can't redirect the user to
// a phishing page that looks like Ollama.
const EXTERNAL_HOSTS = new Set(['ollama.com', 'www.ollama.com', 'github.com'])

ipcMain.on('workbench:open-external', (event, url: unknown) => {
  if (event.sender !== mainWindow?.webContents) return
  if (typeof url !== 'string') return
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return
  }
  if (parsed.protocol !== 'https:') return
  if (!EXTERNAL_HOSTS.has(parsed.hostname.toLowerCase())) return
  void shell.openExternal(parsed.toString())
})

// Strict allowlist for the PowerShell convenience button — only the
// two OLLAMA_* env-var commands the wizard sets, in either
// `$env:` (current session) or `setx` (persisted) form. Anything else
// is rejected. Multiple commands separated by newlines are allowed.
const POWERSHELL_LINE_RE =
  /^\s*(\$env:OLLAMA_[A-Z_]+\s*=\s*"[A-Za-z0-9_.-]+"|setx\s+OLLAMA_[A-Z_]+\s+[A-Za-z0-9_.-]+)\s*$/

ipcMain.on('workbench:spawn-powershell', (event, command: unknown) => {
  if (event.sender !== mainWindow?.webContents) return
  if (typeof command !== 'string') return
  if (process.platform !== 'win32') return
  const lines = command.split(/\r?\n/).filter((l) => l.trim().length > 0)
  if (lines.length === 0) return
  if (!lines.every((l) => POWERSHELL_LINE_RE.test(l))) {
    console.warn('[main] spawn-powershell: rejected non-allowlisted command')
    return
  }
  try {
    // -NoExit keeps the window open after the staged commands run so
    // the user can read setx's confirmation. Detached so the child
    // survives the parent quitting.
    const child = spawn(
      'powershell.exe',
      ['-NoExit', '-Command', lines.join('\n')],
      { detached: true, stdio: 'ignore', windowsHide: false }
    )
    child.unref()
  } catch (err) {
    console.error('[main] spawn-powershell failed:', err)
  }
})

ipcMain.on('workbench:open-settings', (event) => {
  if (event.sender !== mainWindow?.webContents) return
  const win = BrowserWindow.fromWebContents(event.sender) ?? mainWindow
  win?.webContents.send('menu:action', 'settings')
})

// F-list saved-login plumbing. Password lives in the operating
// system's credential store via keytar — Credential Manager on
// Windows, Keychain on macOS, libsecret on Linux. We deliberately
// do NOT write the password to disk in any form, encrypted or
// otherwise: the user explicitly required OS-keychain storage.
//
// Two small non-secret bits — the saved username and the auto-login
// preference — also live in keytar's "account name" metadata so the
// app's userData folder stays free of any login-related state.
// We use a sentinel account row (META_ACCOUNT) to store these.
type SavedCredsResponse = {
  account: string | null
  autoLogin: boolean
  encryptionAvailable: boolean
  hasPassword: boolean
}

const KEYTAR_SERVICE = 'flist-workbench'
// Sentinel "account" key under which we stash the saved-login
// metadata (the real username + auto-login flag) as a JSON blob.
// Real per-user credentials use the username as the keytar account
// so an `awsccredmgr` listing reads naturally as one row per saved
// login. Two underscores make collision with a real username
// vanishingly unlikely.
const META_ACCOUNT = '__meta__'

type SavedMeta = { account: string; autoLogin: boolean }

async function readMeta(): Promise<SavedMeta | null> {
  const kt = loadKeytar()
  if (!kt) return null
  try {
    const raw = await kt.getPassword(KEYTAR_SERVICE, META_ACCOUNT)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<SavedMeta>
    if (typeof parsed.account !== 'string') return null
    return { account: parsed.account, autoLogin: !!parsed.autoLogin }
  } catch {
    return null
  }
}

async function writeMeta(meta: SavedMeta): Promise<void> {
  const kt = loadKeytar()
  if (!kt) throw new Error('keytar unavailable')
  await kt.setPassword(KEYTAR_SERVICE, META_ACCOUNT, JSON.stringify(meta))
}

async function clearAllKeychainEntries(): Promise<void> {
  const kt = loadKeytar()
  if (!kt) return
  try {
    const creds = await kt.findCredentials(KEYTAR_SERVICE)
    for (const c of creds) {
      try {
        await kt.deletePassword(KEYTAR_SERVICE, c.account)
      } catch {
        // Best-effort — keep going on individual failures so we don't
        // leave half-cleared state.
      }
    }
  } catch (err) {
    console.error('[main] keychain clear failed:', err)
  }
}

ipcMain.handle(
  'workbench:creds:get-meta',
  async (event): Promise<SavedCredsResponse> => {
    if (event.sender !== mainWindow?.webContents) {
      return { account: null, autoLogin: false, encryptionAvailable: false, hasPassword: false }
    }
    const kt = loadKeytar()
    if (!kt) {
      return { account: null, autoLogin: false, encryptionAvailable: false, hasPassword: false }
    }
    const meta = await readMeta()
    let hasPassword = false
    if (meta) {
      try {
        const pw = await kt.getPassword(KEYTAR_SERVICE, meta.account)
        hasPassword = pw !== null
      } catch {
        hasPassword = false
      }
    }
    // keytar lazily initialises the platform backend on first call;
    // we treat any successful read above as proof the OS credential
    // store is reachable. Setting the flag from a probe call rather
    // than a static value catches Linux systems missing libsecret.
    let encryptionAvailable = true
    try {
      await kt.findCredentials(KEYTAR_SERVICE)
    } catch {
      encryptionAvailable = false
    }
    return {
      account: meta?.account ?? null,
      autoLogin: meta?.autoLogin ?? false,
      encryptionAvailable,
      hasPassword
    }
  }
)

ipcMain.handle(
  'workbench:creds:get-password',
  async (event): Promise<string | null> => {
    if (event.sender !== mainWindow?.webContents) return null
    const kt = loadKeytar()
    if (!kt) return null
    const meta = await readMeta()
    if (!meta) return null
    try {
      return await kt.getPassword(KEYTAR_SERVICE, meta.account)
    } catch {
      return null
    }
  }
)

ipcMain.handle(
  'workbench:creds:save',
  async (event, payload: unknown): Promise<boolean> => {
    if (event.sender !== mainWindow?.webContents) return false
    if (!payload || typeof payload !== 'object') return false
    const { account, password, autoLogin } = payload as {
      account?: unknown
      password?: unknown
      autoLogin?: unknown
    }
    if (typeof account !== 'string' || account.length === 0) return false
    if (typeof password !== 'string' || password.length === 0) return false
    const kt = loadKeytar()
    if (!kt) return false
    try {
      // If the saved username is changing, drop the old per-user
      // entry so we don't leave stale passwords sitting in the
      // keychain for accounts the user no longer cares about.
      const existing = await readMeta()
      if (existing && existing.account !== account) {
        try {
          await kt.deletePassword(KEYTAR_SERVICE, existing.account)
        } catch {
          // Best-effort
        }
      }
      await kt.setPassword(KEYTAR_SERVICE, account, password)
      await writeMeta({ account, autoLogin: !!autoLogin })
      return true
    } catch (err) {
      console.error('[main] creds save failed:', err)
      return false
    }
  }
)

ipcMain.handle(
  'workbench:creds:set-auto-login',
  async (event, next: unknown): Promise<boolean> => {
    if (event.sender !== mainWindow?.webContents) return false
    if (typeof next !== 'boolean') return false
    const meta = await readMeta()
    if (!meta) return false
    try {
      await writeMeta({ account: meta.account, autoLogin: next })
      return true
    } catch (err) {
      console.error('[main] creds set-auto-login failed:', err)
      return false
    }
  }
)

ipcMain.handle('workbench:creds:clear', async (event): Promise<boolean> => {
  if (event.sender !== mainWindow?.webContents) return false
  await clearAllKeychainEntries()
  return true
})

// Auto-update plumbing. electron-updater pulls latest.yml from the
// GitHub Release configured in electron-builder.yml's `publish:`
// block. We deliberately disable autoDownload so the renderer can
// surface a modal first ("Update available — install now / later?")
// rather than spending the user's bandwidth uninvited. The renderer
// asks main to start the download once the user confirms; main
// forwards progress + completion events back over IPC.
//
// Skipped entirely in dev (`!app.isPackaged`) because electron-updater
// needs a packaged app-update.yml to resolve the feed and will throw
// otherwise. Initial check is delayed so the first-run wizard / sign-in
// modal own the user's attention on launch.
type UpdaterStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; version: string; releaseNotes?: string | null }
  | { kind: 'downloading'; percent: number; bytesPerSecond: number; transferred: number; total: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'not-available' }
  | { kind: 'error'; message: string }

let updaterStatus: UpdaterStatus = { kind: 'idle' }

function sendUpdaterStatus(status: UpdaterStatus): void {
  updaterStatus = status
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updater:status', status)
  }
}

function configureAutoUpdater(): void {
  if (isDev) return
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = {
    info: (m: unknown) => appendDiagLog('updater', m),
    warn: (m: unknown) => appendDiagLog('updater-warn', m),
    error: (m: unknown) => appendDiagLog('updater-error', m),
    debug: () => {}
  }
  autoUpdater.on('checking-for-update', () => sendUpdaterStatus({ kind: 'checking' }))
  autoUpdater.on('update-available', (info) => {
    sendUpdaterStatus({
      kind: 'available',
      version: info.version,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : null
    })
  })
  autoUpdater.on('update-not-available', () => sendUpdaterStatus({ kind: 'not-available' }))
  autoUpdater.on('download-progress', (p) => {
    sendUpdaterStatus({
      kind: 'downloading',
      percent: p.percent,
      bytesPerSecond: p.bytesPerSecond,
      transferred: p.transferred,
      total: p.total
    })
  })
  autoUpdater.on('update-downloaded', (info) => {
    sendUpdaterStatus({ kind: 'downloaded', version: info.version })
  })
  autoUpdater.on('error', (err) => {
    sendUpdaterStatus({ kind: 'error', message: err?.message ?? String(err) })
  })
}

ipcMain.handle('workbench:updater:get-status', (event): UpdaterStatus => {
  if (event.sender !== mainWindow?.webContents) return { kind: 'idle' }
  return updaterStatus
})

ipcMain.handle('workbench:updater:check', async (event): Promise<boolean> => {
  if (event.sender !== mainWindow?.webContents) return false
  if (isDev) return false
  try {
    await autoUpdater.checkForUpdates()
    return true
  } catch (err) {
    appendDiagLog('updater-check-failed', err)
    return false
  }
})

ipcMain.handle('workbench:updater:download', async (event): Promise<boolean> => {
  if (event.sender !== mainWindow?.webContents) return false
  if (isDev) return false
  try {
    await autoUpdater.downloadUpdate()
    return true
  } catch (err) {
    appendDiagLog('updater-download-failed', err)
    return false
  }
})

ipcMain.on('workbench:updater:install', (event) => {
  if (event.sender !== mainWindow?.webContents) return
  if (isDev) return
  // quitAndInstall: closes app, runs the NSIS installer in update mode,
  // then relaunches. `isSilent: true` skips the installer UI; the
  // user already consented in our modal. `isForceRunAfter: true` so
  // we re-open the app once the update finishes.
  autoUpdater.quitAndInstall(true, true)
})

ipcMain.on('menu:set-state', (_event, flags: MenuFlags) => {
  const menu = Menu.getApplicationMenu()
  if (!menu) return
  for (const id of ['classify-current', 'ingest-current'] as const) {
    const item = menu.getMenuItemById(id)
    if (item) item.enabled = !!flags.classifyCurrent
  }
  for (const id of ['classify-character', 'ingest-character'] as const) {
    const item = menu.getMenuItemById(id)
    if (item) item.enabled = !!flags.classifyCharacter
  }
  const backupAll = menu.getMenuItemById('backup-all')
  if (backupAll) backupAll.enabled = !!flags.flistSessionActive
})

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    // Below ~1100 px the editor and preview both compress past readable
    // width (at 800 px the preview was one letter per line). Enforce a
    // floor that keeps the dual-pane layout usable.
    minWidth: 1100,
    minHeight: 600,
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      sandbox: true,
      // Forward the resolved sidecar port + current app version to the
      // sandboxed preload (process.env isn't reliable across the
      // sandbox boundary).
      additionalArguments: [
        `--sidecar-port=${process.env['SIDECAR_PORT'] ?? ''}`,
        `--app-version=${app.getVersion()}`
      ]
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Renderer-side breakage is easy to miss when the only symptom is a
  // blank window. Surface render-process-gone + unresponsive events so
  // dev mode actually tells us when React crashed or the preload bridge
  // failed to install.
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    appendDiagLog('render-process-gone', details)
  })
  mainWindow.on('unresponsive', () => {
    appendDiagLog('unresponsive', 'main window unresponsive')
  })
  mainWindow.webContents.on('preload-error', (_e, preloadPath, error) => {
    appendDiagLog('preload-error', { preloadPath, error: error.message, stack: error.stack })
  })
  // Auto-open DevTools in dev so the renderer console + network panel
  // are one click away. Packaged builds stay clean — F12 still works
  // if a user wants to peek under the hood.
  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  }

  attachContextMenu(mainWindow)

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  appendDiagLog('createWindow', { isDev, devUrl: devUrl ?? null })
  try {
    if (isDev && devUrl) {
      await mainWindow.loadURL(devUrl)
    } else {
      await mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
    }
    appendDiagLog('createWindow', 'load complete')
  } catch (err) {
    appendDiagLog('createWindow-load-failed', err)
    throw err
  }
}

app.whenReady().then(async () => {
  appendDiagLog('whenReady', 'app ready, starting sidecar')
  try {
    await startSidecar()
    appendDiagLog('whenReady', 'sidecar started')
  } catch (err) {
    appendDiagLog('sidecar-failed', err)
  }
  // Menu has to be set after app is ready (uses app.name etc) but
  // before window creation so the new window picks it up.
  try {
    Menu.setApplicationMenu(buildMenu(() => mainWindow))
    appendDiagLog('whenReady', 'menu built')
  } catch (err) {
    appendDiagLog('menu-build-failed', err)
  }
  try {
    await createWindow()
    appendDiagLog('whenReady', 'window created')
  } catch (err) {
    appendDiagLog('createWindow-threw', err)
  }

  // Wire the updater after the window exists so its `update-available`
  // event has a target to push to. 30s delay before the first check
  // gives the first-run wizard + sign-in modal time to land first;
  // an update prompt stacking on top of those would be jarring.
  configureAutoUpdater()
  if (!isDev) {
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch((err) => {
        appendDiagLog('updater-check-failed', err)
      })
    }, 30_000)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}).catch((err) => {
  appendDiagLog('whenReady-rejected', err)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Quit-time ticket invalidation. The TicketStore lives in sidecar RAM,
// which normally dies with the SIGTERM in stopSidecar() — but `uv run`
// in dev doesn't always propagate the signal cleanly to its uvicorn
// child, and any orphaned sidecar process would keep answering with
// the cached ticket on the next launch (same port → renderer talks to
// the survivor). Belt-and-braces fix: explicitly tell the sidecar to
// clear the ticket via the same endpoint the renderer's sign-out path
// uses, then kill the process. Bounded to 1.5s so a frozen sidecar
// can't hang the shutdown.
let quitInvalidationDone = false
app.on('before-quit', async (event) => {
  if (quitInvalidationDone) return
  event.preventDefault()
  quitInvalidationDone = true
  try {
    await Promise.race([
      fetch(`${sidecarUrl}/flist/session`, { method: 'DELETE' }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 1500)
      )
    ])
  } catch {
    // Sidecar unreachable / already gone — SIGTERM below covers it.
  }
  stopSidecar()
  app.quit()
})
