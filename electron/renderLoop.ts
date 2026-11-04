import { sidecarFetch } from './sidecar'
import { renderProfileToPng, type RenderTheme } from './renderProfile'
import type { InlinesManifest } from '../renderer/src/lib/bbcode'
import type { Schema } from '../renderer/src/lib/schema'

/** The long-poll's answer: something to draw, or null. */
type RenderPoll = Schema<'RenderPoll'>
/** Why the window could not draw one. */
type RenderFailedRequest = Schema<'RenderFailedRequest'>

/** Answers the sidecar's render requests for as long as the app runs.
 *
 *  A model connected over MCP asks for a picture of a profile; the
 *  sidecar cannot draw one, so it parks the request and this loop
 *  collects it. Long-poll rather than a socket: one endpoint, no
 *  reconnect logic, and the poll doubles as the app's "I am here"
 *  signal — a tool call checks that and tells the model the window is
 *  closed instead of making it wait out a timeout.
 *
 *  Failures are reported back, never swallowed: a model that asked for
 *  a picture deserves a reason rather than silence.
 */

let running = false
let stopped = false

/** Back-off after a failed poll. The sidecar may still be starting, or
 *  may have died — either way, hammering it helps nobody. */
const RETRY_MS = 3000

async function pollOnce(): Promise<void> {
  const res = await sidecarFetch('/render/requests?timeout=25', {
    method: 'GET'
  })
  if (!res.ok) throw new Error(`poll failed: HTTP ${res.status}`)
  const body = (await res.json()) as RenderPoll
  const req = body.request
  if (!req) return

  try {
    const shot = await renderProfileToPng({
      bbcode: req.bbcode,
      // F-list's inline images, passed through by the sidecar as they
      // are (the schema says only "an object").
      inlines: req.inlines as InlinesManifest,
      // Whatever theme name the MCP tool was given; the preview knows
      // its three and the sidecar does not check.
      theme: req.theme as RenderTheme,
      width: req.width
    })
    await sidecarFetch(`/render/result/${encodeURIComponent(req.id)}`, {
      method: 'POST',
      headers: {
        'Content-Type': shot.mime,
        'X-Render-Size': `${shot.width}x${shot.height}`
      },
      body: new Uint8Array(shot.bytes)
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[render] failed:', message)
    await sidecarFetch(
      `/render/failed/${encodeURIComponent(req.id)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message } satisfies RenderFailedRequest)
      }
    ).catch(() => {
      // The sidecar is gone; the request will expire on its own.
    })
  }
}

export function startRenderLoop(): void {
  if (running) return
  running = true
  stopped = false
  void (async () => {
    while (!stopped) {
      try {
        await pollOnce()
      } catch {
        // Sidecar not up yet, or restarting. Wait and try again —
        // this loop outlives individual sidecar processes.
        await new Promise((r) => setTimeout(r, RETRY_MS))
      }
    }
    running = false
  })()
}

export function stopRenderLoop(): void {
  stopped = true
}
