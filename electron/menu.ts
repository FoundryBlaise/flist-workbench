import { app, BrowserWindow, dialog, Menu, MenuItemConstructorOptions, shell } from 'electron'
import { sidecarUrl } from './sidecar'

// All Workbench-specific menu items send a single channel with a known
// id. The renderer dispatches to its existing handlers. Adding a new
// menu item is "pick an id, add a handler in renderer/src/menuActions.ts".
export type MenuAction =
  | 'mode-editor'
  | 'mode-logs'
  | 'find-contacts'
  | 'search-all-partners'
  | 'settings'
  | 'classify-current'
  | 'classify-character'
  | 'classify-all'
  | 'ingest-current'
  | 'ingest-character'
  | 'ingest-all'
  | 'chat-toggle'
  | 'character-assistant'
  | 'ai-setup'
  | 'flist-activity'
  | 'restore-userscript-help'
  | 'backup-all'

// Lives in the main process because it touches shell.openPath; we
// resolve the path from the sidecar so user_data_dir() stays the one
// source of truth across both processes.
async function openClassifyFailureLog(win: BrowserWindow | null): Promise<void> {
  try {
    const res = await fetch(`${sidecarUrl}/labels/failure-log`)
    if (!res.ok) throw new Error(`sidecar returned HTTP ${res.status}`)
    const body = (await res.json()) as { path: string; exists: boolean; byte_size: number }
    if (!body.exists || body.byte_size === 0) {
      // No failures yet — show the dir in the file manager so the user
      // can still find the location, with a friendly note.
      const opts = {
        type: 'info' as const,
        title: 'No classify failures yet',
        message: 'No failed classifications have been recorded.',
        detail:
          `When the classifier can't parse the LLM's reply, the message + ` +
          `prompt + error go here:\n\n${body.path}\n\n` +
          `The file is created on the first failure.`,
        buttons: ['OK']
      }
      if (win) await dialog.showMessageBox(win, opts)
      else await dialog.showMessageBox(opts)
      return
    }
    // Best-effort: shell.openPath returns a non-empty string on error.
    const err = await shell.openPath(body.path)
    if (err) {
      // Fallback to revealing in the OS file manager.
      shell.showItemInFolder(body.path)
    }
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    const opts = {
      type: 'error' as const,
      title: "Couldn't open failure log",
      message: 'The sidecar is not reachable or returned an error.',
      detail,
      buttons: ['OK']
    }
    if (win) await dialog.showMessageBox(win, opts)
    else await dialog.showMessageBox(opts)
  }
}

function send(win: BrowserWindow | null, action: MenuAction): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send('menu:action', action)
  }
}

export function buildMenu(getWindow: () => BrowserWindow | null): Menu {
  const isMac = process.platform === 'darwin'

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ]
          }
        ]
      : []),
    {
      label: '&File',
      submenu: [isMac ? { role: 'close' } : { role: 'quit' }]
    },
    {
      label: '&Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: '&View',
      submenu: [
        {
          label: 'Editor Mode',
          accelerator: 'CmdOrCtrl+1',
          click: () => send(getWindow(), 'mode-editor')
        },
        {
          label: 'Logs Mode',
          accelerator: 'CmdOrCtrl+2',
          click: () => send(getWindow(), 'mode-logs')
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: '&Logs',
      submenu: [
        {
          id: 'find-contacts',
          label: 'Find Contacts…',
          click: () => send(getWindow(), 'find-contacts')
        },
        {
          id: 'search-all-partners',
          label: 'Search All Partners…',
          click: () => send(getWindow(), 'search-all-partners')
        },
        { type: 'separator' },
        {
          id: 'classify-current',
          label: 'Classify Current Conversation…',
          enabled: false,
          click: () => send(getWindow(), 'classify-current')
        },
        {
          id: 'classify-character',
          label: 'Classify Active Character…',
          enabled: false,
          click: () => send(getWindow(), 'classify-character')
        },
        {
          id: 'classify-all',
          label: 'Classify All Characters…',
          click: () => send(getWindow(), 'classify-all')
        },
        { type: 'separator' },
        {
          id: 'ingest-current',
          label: 'Ingest Current Conversation (RAG)…',
          enabled: false,
          click: () => send(getWindow(), 'ingest-current')
        },
        {
          id: 'ingest-character',
          label: 'Ingest Active Character (RAG)…',
          enabled: false,
          click: () => send(getWindow(), 'ingest-character')
        },
        {
          id: 'ingest-all',
          label: 'Ingest All Characters (RAG)…',
          click: () => send(getWindow(), 'ingest-all')
        }
      ]
    },
    {
      label: '&Tools',
      submenu: [
        {
          id: 'chat-toggle',
          label: 'Ask the logs…',
          accelerator: 'CmdOrCtrl+J',
          click: () => send(getWindow(), 'chat-toggle')
        },
        {
          // Hidden until the user flips the AI Assistant master toggle in
          // Settings (Phase 9 opt-in gate). The main process re-builds the
          // menu via menu:set-state when the flag changes, so this becomes
          // visible without an app relaunch.
          id: 'character-assistant',
          label: 'Character Assistant…',
          accelerator: 'CmdOrCtrl+Shift+J',
          visible: false,
          click: () => send(getWindow(), 'character-assistant')
        },
        { type: 'separator' },
        {
          id: 'backup-all',
          label: 'Back up all characters',
          enabled: false,
          click: () => send(getWindow(), 'backup-all')
        },
        {
          id: 'open-classify-log',
          label: 'Open Classify Failure Log…',
          click: () => {
            void openClassifyFailureLog(getWindow())
          }
        },
        { type: 'separator' },
        {
          id: 'settings',
          label: 'Settings…',
          accelerator: 'CmdOrCtrl+,',
          click: () => send(getWindow(), 'settings')
        }
      ]
    },
    {
      label: '&Help',
      submenu: [
        {
          id: 'ai-setup-help',
          label: 'AI Setup…',
          click: () => send(getWindow(), 'ai-setup')
        },
        {
          id: 'flist-activity',
          label: 'F-list Activity Log…',
          click: () => send(getWindow(), 'flist-activity')
        },
        {
          id: 'restore-userscript-help',
          label: 'Install Restore Userscript…',
          click: () => send(getWindow(), 'restore-userscript-help')
        },
        { type: 'separator' },
        {
          label: 'About F-list Workbench',
          click: () => {
            const win = getWindow()
            const opts = {
              type: 'info' as const,
              title: 'About F-list Workbench',
              message: 'F-list Workbench',
              detail: `Version ${app.getVersion()}\nElectron ${process.versions.electron}\nNode ${process.versions.node}`,
              buttons: ['OK']
            }
            if (win) dialog.showMessageBox(win, opts)
            else dialog.showMessageBox(opts)
          }
        },
        {
          label: 'Project on GitHub',
          click: () => {
            void shell.openExternal('https://github.com/FoundryBlaise/flist-workbench')
          }
        }
      ]
    }
  ]

  return Menu.buildFromTemplate(template)
}
