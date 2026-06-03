import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { startSidecar, stopSidecar, sidecarUrl } from './sidecar'
import { buildMenu } from './menu'
import { attachContextMenu } from './contextMenu'

const isDev = !app.isPackaged

let mainWindow: BrowserWindow | null = null

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
      // Forward the resolved sidecar port to the sandboxed preload
      // (process.env isn't reliable across the sandbox boundary).
      additionalArguments: [`--sidecar-port=${process.env['SIDECAR_PORT'] ?? ''}`]
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  attachContextMenu(mainWindow)

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (isDev && devUrl) {
    await mainWindow.loadURL(devUrl)
  } else {
    await mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  try {
    await startSidecar()
  } catch (err) {
    console.error('[main] sidecar failed to start:', err)
  }
  // Menu has to be set after app is ready (uses app.name etc) but
  // before window creation so the new window picks it up.
  Menu.setApplicationMenu(buildMenu(() => mainWindow))
  await createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
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
