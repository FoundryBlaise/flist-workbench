import { contextBridge, ipcRenderer } from 'electron'

const sidecarPort = Number(process.env['SIDECAR_PORT'] ?? 8765)

contextBridge.exposeInMainWorld('workbench', {
  sidecarUrl: `http://127.0.0.1:${sidecarPort}`,
  selectDirectory: (opts?: { title?: string; defaultPath?: string }) =>
    ipcRenderer.invoke('workbench:select-directory', opts ?? {}) as Promise<string | null>
})
