import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron'
import { join } from 'node:path'
import { startSidecar, stopSidecar } from './sidecar'
import { buildMenu } from './menu'

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

// Renderer reports which classify scopes are reachable so the native
// menu can grey out items that would otherwise no-op silently. The
// renderer keeps the canonical state (it knows the active character
// and partner); main just mirrors it onto the menu items.
type MenuFlags = {
  classifyCurrent: boolean
  classifyCharacter: boolean
}
ipcMain.on('menu:set-state', (_event, flags: MenuFlags) => {
  const menu = Menu.getApplicationMenu()
  if (!menu) return
  const cur = menu.getMenuItemById('classify-current')
  const ch = menu.getMenuItemById('classify-character')
  if (cur) cur.enabled = !!flags.classifyCurrent
  if (ch) ch.enabled = !!flags.classifyCharacter
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

app.on('before-quit', () => {
  stopSidecar()
})
