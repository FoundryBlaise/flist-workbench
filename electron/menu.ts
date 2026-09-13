import { app, BrowserWindow, dialog, Menu, MenuItemConstructorOptions, shell } from 'electron'

// All Workbench-specific menu items send a single channel with a known
// id. The renderer dispatches to its existing handlers. Adding a new
// menu item is "pick an id, add a handler in renderer/src/menuActions.ts".
export type MenuAction =
  | 'mode-editor'
  | 'mode-logs'
  | 'find-contacts'
  | 'search-all-partners'
  | 'settings'
  | 'ingest-current'
  | 'ingest-character'
  | 'ingest-all'
  | 'flist-activity'
  | 'restore-userscript-help'
  | 'backup-all'
  | 'check-updates'
  | 'edit-undo'
  | 'edit-redo'

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
        // role:'undo' would call webContents.undo() which only knows
        // about Chromium's native input/contenteditable undo stack —
        // CodeMirror's history is invisible to it, so the menu item
        // did nothing when the editor was focused. We route through
        // the renderer instead, which dispatches to CM or the native
        // field depending on what's focused.
        //
        // registerAccelerator: false keeps the menu item displaying
        // the Ctrl/Cmd+Z hint without claiming the keystroke, so
        // CodeMirror's keymap still gets first crack at it (and our
        // preview contentEditable handler too).
        {
          id: 'edit-undo',
          label: 'Undo',
          accelerator: 'CmdOrCtrl+Z',
          registerAccelerator: false,
          click: () => send(getWindow(), 'edit-undo')
        },
        {
          id: 'edit-redo',
          label: 'Redo',
          accelerator: 'CmdOrCtrl+Shift+Z',
          registerAccelerator: false,
          click: () => send(getWindow(), 'edit-redo')
        },
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
          id: 'backup-all',
          label: 'Back up all characters',
          enabled: false,
          click: () => send(getWindow(), 'backup-all')
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
          id: 'check-updates',
          label: 'Check for Updates…',
          click: () => send(getWindow(), 'check-updates')
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
