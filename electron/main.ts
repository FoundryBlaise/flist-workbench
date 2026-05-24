import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { join } from 'node:path'
import { startSidecar, stopSidecar } from './sidecar'

const isDev = !app.isPackaged

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

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
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
      sandbox: true
    }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (isDev && devUrl) {
    await win.loadURL(devUrl)
  } else {
    await win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  try {
    await startSidecar()
  } catch (err) {
    console.error('[main] sidecar failed to start:', err)
  }
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
