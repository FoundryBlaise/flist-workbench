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
  | 'classify-current'
  | 'classify-character'
  | 'classify-all'
  | 'ingest-current'
  | 'ingest-character'
  | 'ingest-all'
  | 'chat-toggle'

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
