import { ipcMain, type BrowserWindow } from 'electron'

// Before the app's page goes away (the window closes, reloads or the
// app quits), main asks it to save the edits its autosave has not sent
// yet, and waits. The page saves with its ordinary requests, from the
// app window's main frame while it still shows the app, so they carry
// the launch secret like any other (ADR 0002). Nothing is left for the
// page to send while it unloads.

/** Main → page: "save your pending edits now", with a request id. */
export const SAVE_EDITS_CHANNEL = 'workbench:save-edits'
/** Page → main: the edits of that request id are saved (or failed). */
export const EDITS_SAVED_CHANNEL = 'workbench:edits-saved'

/** How long a page gets to save before it goes away regardless. */
export const SAVE_EDITS_TIMEOUT_MS = 3_000

let nextRequestId = 1
const waiting = new Map<number, { sender: Electron.WebContents; done: () => void }>()

ipcMain.on(EDITS_SAVED_CHANNEL, (event, id: unknown) => {
  if (typeof id !== 'number') return
  const entry = waiting.get(id)
  // Only the page that was asked can answer for it.
  if (!entry || entry.sender !== event.sender) return
  entry.done()
})

/** One save per window at a time: a second close click joins the first. */
const inflight = new WeakMap<BrowserWindow, Promise<void>>()

/**
 * Asks the page in `win` to save its pending edits and resolves once it
 * has, or after SAVE_EDITS_TIMEOUT_MS, so a hung or crashed page never
 * keeps the window open. Never rejects.
 */
export function saveEditsBeforeUnload(win: BrowserWindow): Promise<void> {
  if (win.isDestroyed() || win.webContents.isCrashed()) return Promise.resolve()
  const running = inflight.get(win)
  if (running) return running
  const contents = win.webContents
  const id = nextRequestId++
  const saved = new Promise<void>((resolve) => {
    // Called only by the timer or the page's answer, both after `timer` is set.
    const finish = (): void => {
      clearTimeout(timer)
      waiting.delete(id)
      inflight.delete(win)
      resolve()
    }
    const timer = setTimeout(finish, SAVE_EDITS_TIMEOUT_MS)
    waiting.set(id, { sender: contents, done: finish })
    contents.send(SAVE_EDITS_CHANNEL, id)
  })
  inflight.set(win, saved)
  return saved
}

/** Windows whose page has saved and that may now close at once. */
const mayClose = new WeakSet<BrowserWindow>()

/**
 * Makes closing `win` wait for its page to save: the close is held,
 * the page saves, then the window closes for real.
 */
export function saveEditsOnClose(win: BrowserWindow): void {
  win.on('close', (event) => {
    if (mayClose.has(win)) return
    event.preventDefault()
    void saveEditsAndAllowClose(win).then(() => {
      if (!win.isDestroyed()) win.close()
    })
  })
}

/**
 * Saves the page's pending edits, as saveEditsBeforeUnload, and lets
 * the window close afterwards without asking its page again: the
 * app's quit, which closes the window itself.
 */
export async function saveEditsAndAllowClose(win: BrowserWindow): Promise<void> {
  await saveEditsBeforeUnload(win)
  mayClose.add(win)
}
