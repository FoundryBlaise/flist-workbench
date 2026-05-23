import { contextBridge } from 'electron'

const sidecarPort = Number(process.env['SIDECAR_PORT'] ?? 8765)

contextBridge.exposeInMainWorld('workbench', {
  sidecarUrl: `http://127.0.0.1:${sidecarPort}`
})
