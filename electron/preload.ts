import { contextBridge, ipcRenderer } from 'electron'

// Main passes --sidecar-port=NNNN via webPreferences.additionalArguments.
// Sandboxed preload can't rely on process.env, so prefer the argv.
function resolvePort(): number {
  const arg = process.argv.find((a) => a.startsWith('--sidecar-port='))
  if (arg) return Number(arg.split('=')[1])
  const env = process.env['SIDECAR_PORT']
  if (env) return Number(env)
  return 27384
}

const sidecarPort = resolvePort()

function resolveAppVersion(): string {
  const arg = process.argv.find((a) => a.startsWith('--app-version='))
  if (arg) return arg.split('=')[1] ?? ''
  return ''
}

const appVersion = resolveAppVersion()

// Menu items in main send `menu:action` with a string id; renderer subscribes
// here. Returns an unsubscriber so React effects can clean up on unmount.
type MenuActionListener = (action: string) => void

contextBridge.exposeInMainWorld('workbench', {
  sidecarUrl: `http://127.0.0.1:${sidecarPort}`,
  appVersion,
  selectDirectory: (opts?: { title?: string; defaultPath?: string }) =>
    ipcRenderer.invoke('workbench:select-directory', opts ?? {}) as Promise<string | null>,
  // Working-set bundle export/import — pick a file path, then the
  // renderer streams bytes through main. The renderer never sees a
  // Node fs handle directly.
  saveFileDialog: (opts?: {
    title?: string
    defaultPath?: string
    filters?: { name: string; extensions: string[] }[]
  }) =>
    ipcRenderer.invoke('workbench:save-file-dialog', opts ?? {}) as Promise<
      string | null
    >,
  openFileDialog: (opts?: {
    title?: string
    defaultPath?: string
    filters?: { name: string; extensions: string[] }[]
  }) =>
    ipcRenderer.invoke('workbench:open-file-dialog', opts ?? {}) as Promise<
      string | null
    >,
  readFile: (filePath: string) =>
    ipcRenderer.invoke('workbench:read-file', filePath) as Promise<
      Uint8Array | null
    >,
  writeFile: (filePath: string, bytes: Uint8Array) =>
    ipcRenderer.invoke('workbench:write-file', filePath, bytes) as Promise<
      boolean
    >,
  onMenuAction: (listener: MenuActionListener) => {
    const wrapped = (_event: unknown, action: string): void => listener(action)
    ipcRenderer.on('menu:action', wrapped)
    return () => {
      ipcRenderer.removeListener('menu:action', wrapped)
    }
  },
  setMenuState: (flags: {
    classifyCurrent: boolean
    classifyCharacter: boolean
    flistSessionActive: boolean
  }) => {
    ipcRenderer.send('menu:set-state', flags)
  },
  // Used by the AI Setup wizard to open ollama.com/download in the user's
  // default browser. Main does the actual shell.openExternal call so the
  // renderer never holds a Node module reference.
  openExternal: (url: string) => {
    ipcRenderer.send('workbench:open-external', url)
  },
  // Fetch raw image bytes for the right-click "Copy image" action.
  // Main has a host allowlist + https-only filter; nulls back on
  // anything else.
  fetchImageBytes: (url: string) =>
    ipcRenderer.invoke('workbench:fetch-image-bytes', url) as Promise<
      { bytes: Uint8Array; mime: string } | null
    >,
  // Convenience for the env-var page: spawns a PowerShell window with
  // the supplied commands ready to run. Windows-only; main checks the
  // platform and no-ops elsewhere.
  spawnPowerShell: (command: string) => {
    ipcRenderer.send('workbench:spawn-powershell', command)
  },
  // The Done page's "Open Settings" CTA — fires the same menu action
  // path settings already use, so the modal opens consistently.
  openSettings: () => {
    ipcRenderer.send('workbench:open-settings')
  },
  // F-list saved credentials. Password is encrypted with the OS
  // keychain (safeStorage / DPAPI / Keychain / libsecret) in main;
  // the renderer only ever sees plaintext briefly to feed back into
  // the sign-in form. Meta (username, auto-login flag) is separate
  // so we can read the username for pre-fill without touching the
  // encrypted blob.
  creds: {
    getMeta: () =>
      ipcRenderer.invoke('workbench:creds:get-meta') as Promise<{
        account: string | null
        autoLogin: boolean
        encryptionAvailable: boolean
        hasPassword: boolean
      }>,
    getPassword: () =>
      ipcRenderer.invoke('workbench:creds:get-password') as Promise<string | null>,
    save: (payload: { account: string; password: string; autoLogin: boolean }) =>
      ipcRenderer.invoke('workbench:creds:save', payload) as Promise<boolean>,
    setAutoLogin: (next: boolean) =>
      ipcRenderer.invoke('workbench:creds:set-auto-login', next) as Promise<boolean>,
    clear: () =>
      ipcRenderer.invoke('workbench:creds:clear') as Promise<boolean>
  },
  // Auto-updater bridge. Main owns the electron-updater state machine;
  // the renderer just listens for status changes and dispatches user
  // intent (download / install) back over IPC.
  updater: {
    getStatus: () =>
      ipcRenderer.invoke('workbench:updater:get-status') as Promise<unknown>,
    check: () =>
      ipcRenderer.invoke('workbench:updater:check') as Promise<boolean>,
    download: () =>
      ipcRenderer.invoke('workbench:updater:download') as Promise<boolean>,
    install: () => {
      ipcRenderer.send('workbench:updater:install')
    },
    onStatus: (listener: (status: unknown) => void) => {
      const wrapped = (_event: unknown, status: unknown) => listener(status)
      ipcRenderer.on('updater:status', wrapped)
      return () => {
        ipcRenderer.removeListener('updater:status', wrapped)
      }
    }
  }
})
