import { contextBridge, ipcRenderer } from 'electron'

// Main passes --sidecar-port=NNNN via webPreferences.additionalArguments.
// Sandboxed preload can't rely on process.env, so prefer the argv.
function resolvePort(): number {
  const arg = process.argv.find((a) => a.startsWith('--sidecar-port='))
  if (arg) return Number(arg.split('=')[1])
  const env = process.env['SIDECAR_PORT']
  if (env) return Number(env)
  return 8770
}

const sidecarPort = resolvePort()

contextBridge.exposeInMainWorld('workbench', {
  sidecarUrl: `http://127.0.0.1:${sidecarPort}`,
  selectDirectory: (opts?: { title?: string; defaultPath?: string }) =>
    ipcRenderer.invoke('workbench:select-directory', opts ?? {}) as Promise<string | null>
})
