// One fake sidecar for the renderer tests, installed as `fetch`.
//
// Routes are written as "METHOD /path" strings or RegExps tested
// against "METHOD /path?query". A string without a "?" ignores the
// query; one with a "?" must match it exactly.
//
// A request is answered by, in this order: the oldest matching `once`
// reply, a matching `hold` (the request waits until the test settles
// it), the newest matching `on` reply, the `fallback`. Anything else is
// rejected with an error naming the request, so a test never passes
// against a route it forgot to set up.
//
// Held requests are the point: a test can leave a save in flight, type
// over it, and then release or fail the responses in whatever order the
// race it is pinning needs. `restore()` rejects anything still held so
// the store's per-character save chain does not leak into the next
// test.

export type RecordedRequest = {
  method: string
  /** Path plus query, without the sidecar base URL. */
  path: string
  headers: Record<string, string>
  /** JSON-parsed when the body was JSON, the raw string otherwise. */
  body: unknown
}

export type FakeReply =
  | { kind: 'json'; status: number; body: unknown }
  | { kind: 'error'; error: Error }

export type Route = string | RegExp
type Responder = FakeReply | ((req: RecordedRequest) => FakeReply)

export type PendingRequest = {
  request: RecordedRequest
  resolve: (reply: FakeReply) => void
  /** Fails the request; defaults to a network error. A status reply
   *  (`json(..., 409)`) goes through `resolve` instead. */
  reject: (reply?: FakeReply) => void
}

export type FakeApi = {
  /** Every request in the order it was made, answered or not. */
  readonly requests: RecordedRequest[]
  requestsTo: (route: Route) => RecordedRequest[]
  on: (route: Route, reply: Responder) => FakeApi
  once: (route: Route, reply: Responder) => FakeApi
  hold: (route: Route) => FakeApi
  fallback: (reply: Responder) => FakeApi
  /** Held requests not yet settled, oldest first. */
  pending: (route?: Route) => PendingRequest[]
  restore: () => void
}

/** A JSON reply. Any status outside 2xx reaches the app as an error. */
export function json(body: unknown, status = 200): FakeReply {
  return { kind: 'json', status, body }
}

/** The fetch itself fails, the way it does when the sidecar is down. */
export function networkError(message = 'network error'): FakeReply {
  return { kind: 'error', error: new TypeError(message) }
}

function matches(route: Route, req: RecordedRequest): boolean {
  if (route instanceof RegExp) return route.test(`${req.method} ${req.path}`)
  const space = route.indexOf(' ')
  const method = route.slice(0, space).toUpperCase()
  const path = route.slice(space + 1)
  if (method !== req.method) return false
  const target = path.includes('?') ? req.path : req.path.split('?')[0]
  return target === path
}

function toRecord(init?: RequestInit): Record<string, string> {
  const raw = init?.headers
  if (!raw) return {}
  if (raw instanceof Headers) return Object.fromEntries(raw.entries())
  if (Array.isArray(raw)) return Object.fromEntries(raw)
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, String(v)]))
}

function parseBody(body: unknown): unknown {
  if (typeof body !== 'string') return body ?? undefined
  try {
    return JSON.parse(body)
  } catch {
    return body
  }
}

function toResponse(reply: FakeReply): Response {
  if (reply.kind === 'error') throw reply.error
  const noBody = reply.status === 204 || reply.status === 304
  return new Response(noBody ? null : JSON.stringify(reply.body ?? null), {
    status: reply.status,
    headers: { 'Content-Type': 'application/json' }
  })
}

export function installFakeApi(): FakeApi {
  const original = globalThis.fetch
  const requests: RecordedRequest[] = []
  const onceRoutes: { route: Route; reply: Responder }[] = []
  const standing: { route: Route; reply: Responder }[] = []
  const holds: Route[] = []
  const held: (PendingRequest & { settled: boolean })[] = []
  let fallbackReply: Responder | null = null

  const answer = (reply: Responder, req: RecordedRequest) =>
    toResponse(typeof reply === 'function' ? reply(req) : reply)

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' || input instanceof URL ? input : input.url
    )
    const req: RecordedRequest = {
      method: (init?.method ?? 'GET').toUpperCase(),
      path: url.pathname + url.search,
      headers: toRecord(init),
      body: parseBody(init?.body)
    }
    requests.push(req)

    const onceIdx = onceRoutes.findIndex((r) => matches(r.route, req))
    if (onceIdx >= 0) {
      const [hit] = onceRoutes.splice(onceIdx, 1)
      return answer(hit.reply, req)
    }
    if (holds.some((route) => matches(route, req))) {
      return new Promise<Response>((resolve, reject) => {
        const entry = {
          request: req,
          settled: false,
          resolve: (reply: FakeReply) => {
            if (entry.settled) throw new Error(`already settled: ${req.method} ${req.path}`)
            entry.settled = true
            try {
              resolve(toResponse(reply))
            } catch (e) {
              reject(e)
            }
          },
          reject: (reply: FakeReply = networkError()) => entry.resolve(reply)
        }
        held.push(entry)
      })
    }
    const hit = [...standing].reverse().find((r) => matches(r.route, req))
    if (hit) return answer(hit.reply, req)
    if (fallbackReply) return answer(fallbackReply, req)
    throw new Error(`fakeApi: no route for ${req.method} ${req.path}`)
  }

  const api: FakeApi = {
    requests,
    requestsTo: (route) => requests.filter((r) => matches(route, r)),
    on(route, reply) {
      standing.push({ route, reply })
      return api
    },
    once(route, reply) {
      onceRoutes.push({ route, reply })
      return api
    },
    hold(route) {
      holds.push(route)
      return api
    },
    fallback(reply) {
      fallbackReply = reply
      return api
    },
    pending: (route) =>
      held.filter((p) => !p.settled && (!route || matches(route, p.request))),
    restore() {
      for (const p of held) {
        if (!p.settled) p.reject(networkError('fakeApi: test ended'))
      }
      globalThis.fetch = original
    }
  }
  return api
}
