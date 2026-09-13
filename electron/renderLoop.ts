import { sidecarUrl } from './sidecar'
import { renderProfileToPng, type RenderTheme } from './renderProfile'
import type { InlinesManifest } from '../renderer/src/lib/bbcode'

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

type RenderRequest = {
  id: string
  bbcode: string
  inlines?: InlinesManifest
  theme?: RenderTheme
  width?: number
  label?: string
}

let running = false
let stopped = false

/** Back-off after a failed poll. The sidecar may still be starting, or
 *  may have died — either way, hammering it helps nobody. */
const RETRY_MS = 3000

async function pollOnce(): Promise<void> {
  const res = await fetch(`${sidecarUrl}/render/requests?timeout=25`, {
    method: 'GET'
  })
  if (!res.ok) throw new Error(`poll failed: HTTP ${res.status}`)
  const body = (await res.json()) as { request: RenderRequest | null }
  const req = body.request
  if (!req) return

  try {
    const shot = await renderProfileToPng({
      bbcode: req.bbcode,
      inlines: req.inlines,
      theme: req.theme,
      width: req.width
    })
    await fetch(`${sidecarUrl}/render/result/${encodeURIComponent(req.id)}`, {
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
    await fetch(
      `${sidecarUrl}/render/failed/${encodeURIComponent(req.id)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message })
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
