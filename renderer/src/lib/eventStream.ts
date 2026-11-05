/** Subscription to the sidecar's change broadcast.
 *
 *  The window is no longer the only thing that writes: a model
 *  connected over MCP edits the same Workbench, labels the same
 *  logs and changes the same settings. Without this the window would
 *  keep showing a stale draft and then autosave it back over the
 *  model's work.
 *
 *  Deliberately thin. An event is a hint — the store re-reads through
 *  the normal endpoints when one arrives. The stream is read through
 *  the request function (`api.changeEvents`), like every other route. */

import { api, type ChangeEventHandlers, type Schema } from './api'

/** A change hint, as the sidecar's schema declares it (`ChangeHint`):
 *  which `event`, when (`at`), who made it (`origin`: `ui` for this
 *  window, `mcp:<tool>` for a connected model) and what it is about
 *  (`character_id` and the Workbench's new `etag`; for
 *  `settings-changed`, `changed`: each field as stored, keyed by the
 *  settings service's names, null = back to default). */
export type WorkbenchEvent = Schema<'ChangeHint'>

export type EventHandler = (event: WorkbenchEvent) => void

/** Every event the sidecar publishes (`services/events.py`). The
 *  sidecar names each frame, so an event missing here never reaches
 *  the window. */
export const WORKBENCH_EVENT_NAMES = [
  'set-payload-changed',
  'sets-changed',
  'live-changed',
  'labels-changed',
  'settings-changed',
  'index-changed',
  'images-changed',
  'backups-changed',
  'characters-changed'
] as const satisfies readonly WorkbenchEvent['event'][]

/** How long the window waits before it opens the stream again after it
 *  ended or failed: three seconds, as the browser's own event-stream
 *  client does. */
export const RECONNECT_MS = 3000

/** Open the stream. Returns a function that closes it.
 *
 *  When the stream ends, or cannot be opened (the sidecar restarting
 *  mid-session, a network blip), it is opened again after
 *  `reconnectMs`, so the window is never left permanently blind. */
export function subscribeToWorkbenchEvents(
  onEvent: EventHandler,
  { reconnectMs = RECONNECT_MS }: { reconnectMs?: number } = {}
): () => void {
  const controller = new AbortController()
  let retry: ReturnType<typeof setTimeout> | undefined

  const handle = (hint: WorkbenchEvent) => {
    if (!hint || typeof hint.event !== 'string') return
    onEvent(hint)
  }
  const handlers: ChangeEventHandlers = Object.fromEntries(
    WORKBENCH_EVENT_NAMES.map((name) => [name, handle])
  )

  const open = async () => {
    try {
      await api.changeEvents(handlers, { signal: controller.signal })
    } catch {
      // Unreachable or refused: tried again below, as when it ends.
    }
    if (controller.signal.aborted) return
    retry = setTimeout(() => void open(), reconnectMs)
  }
  void open()

  return () => {
    controller.abort()
    clearTimeout(retry)
  }
}
