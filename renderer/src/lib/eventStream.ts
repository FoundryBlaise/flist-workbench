/** Subscription to the sidecar's change broadcast.
 *
 *  The window is no longer the only thing that writes: a model
 *  connected over MCP edits the same working sets, labels the same
 *  logs and changes the same settings. Without this the window would
 *  keep showing a stale draft and then autosave it back over the
 *  model's work.
 *
 *  Deliberately thin. An event is a hint — the store re-reads through
 *  the normal endpoints when one arrives. */

export type WorkbenchEvent = {
  event: string
  at: number
  /** Who made the change: `ui` for this window, `mcp:<tool>` for a
   *  connected model. */
  origin: string
  character_id?: string
  set_id?: string | null
  etag?: string | null
  character?: string
  partner?: string
}

export type EventHandler = (event: WorkbenchEvent) => void

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

  // The sidecar names each frame, so a generic `message` listener
  // never fires — every event type has to be subscribed by name.
  const NAMES = [
    'set-payload-changed',
    'sets-changed',
    'active-set-changed',
    'live-changed',
    'labels-changed',
    'settings-changed',
    'index-changed'
  ]
  for (const name of NAMES) source.addEventListener(name, handle)

  return () => {
    for (const name of NAMES) source.removeEventListener(name, handle)
    source.close()
  }
}
