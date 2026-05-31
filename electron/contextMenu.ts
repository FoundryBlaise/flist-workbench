import { BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'

// Wires a standard Cut/Copy/Paste/Undo/Redo/Select All context menu onto
// a window's WebContents. Electron ships no default context menu, so
// without this right-clicking inside the editor does nothing. The menu
// uses each item's edit-flag from the hit-test so unavailable actions
// (e.g. Paste with an empty clipboard, Cut on a read-only span) appear
// dimmed instead of vanishing — keeps the menu shape predictable.
export function attachContextMenu(win: BrowserWindow): void {
  win.webContents.on('context-menu', (_e, params) => {
    const wc = win.webContents
    const f = params.editFlags
    const template: MenuItemConstructorOptions[] = [
      { label: 'Undo', enabled: f.canUndo, click: () => wc.undo() },
      { label: 'Redo', enabled: f.canRedo, click: () => wc.redo() },
      { type: 'separator' },
      { label: 'Cut', enabled: f.canCut, click: () => wc.cut() },
      { label: 'Copy', enabled: f.canCopy, click: () => wc.copy() },
      { label: 'Paste', enabled: f.canPaste, click: () => wc.paste() },
      { type: 'separator' },
      { label: 'Select All', enabled: f.canSelectAll, click: () => wc.selectAll() }
    ]
    Menu.buildFromTemplate(template).popup({ window: win })
  })
}
