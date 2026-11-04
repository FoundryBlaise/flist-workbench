/** Subscription to the sidecar's change broadcast.
 *
 *  The window is no longer the only thing that writes: a model
 *  connected over MCP edits the same Workbench, labels the same
 *  logs and changes the same settings. Without this the window would
 *  keep showing a stale draft and then autosave it back over the
 *  model's work.
 *
 *  Deliberately thin. An event is a hint — the store re-reads through
 *  the normal endpoints when one arrives. */

import type { Schema } from './api'

/** A change hint, as the sidecar's schema declares it (`ChangeHint`):
 *  which `event`, when (`at`), who made it (`origin`: `ui` for this
 *  window, `mcp:<tool>` for a connected model) and what it is about
 *  (`character_id` and the Workbench's new `etag`; for
 *  `settings-changed`, `changed`: each field as stored, keyed by the
 *  settings service's names, null = back to default). */
export type WorkbenchEvent = Schema<'ChangeHint'>

export type EventHandler = (event: WorkbenchEvent) => void

/** Every event the sidecar publishes (`services/events.py`). It names
 *  each frame, so a generic `message` listener never fires: an event
 *  missing here never reaches the window. */
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

/** Open the stream. Returns a function that closes it.
 *
 *  `EventSource` reconnects on its own after a network blip, which is
 *  the behaviour we want — the sidecar restarting mid-session should
 *  not leave the window permanently blind. */
export function subscribeToWorkbenchEvents(
  baseUrl: string,
  onEvent: EventHandler
): () => void {
  if (typeof EventSource === 'undefined') {
    // jsdom in unit tests, and any host without the API.
    return () => {}
  }

  const source = new EventSource(`${baseUrl}/events`)

  const handle = (raw: MessageEvent) => {
    let parsed: WorkbenchEvent
    try {
      parsed = JSON.parse(raw.data) as WorkbenchEvent
    } catch {
      return
    }
    if (!parsed || typeof parsed.event !== 'string') return
    onEvent(parsed)
  }

  for (const name of WORKBENCH_EVENT_NAMES) source.addEventListener(name, handle)

  return () => {
    for (const name of WORKBENCH_EVENT_NAMES) source.removeEventListener(name, handle)
    source.close()
  }
}
