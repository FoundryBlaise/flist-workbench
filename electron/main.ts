import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { startSidecar, stopSidecar } from './sidecar'

const isDev = !app.isPackaged

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
