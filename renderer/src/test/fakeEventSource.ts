// A stand-in for the browser's EventSource, which jsdom lacks: the
// sidecar's `/events` stream, with the test playing the sidecar.
//
//   const sources = installFakeEventSource()
//   ...subscribe...
//   sources.last().emit('set-payload-changed', { event: 'set-payload-changed', ... })
//   sources.restore()

type Listener = (e: MessageEvent) => void

export class FakeEventSource {
  readonly url: string
  closed = false
  private readonly listeners = new Map<string, Set<Listener>>()

  constructor(url: string) {
    this.url = url
    created.push(this)
  }

  addEventListener(name: string, listener: Listener): void {
    const set = this.listeners.get(name) ?? new Set<Listener>()
    set.add(listener)
    this.listeners.set(name, set)
  }

  removeEventListener(name: string, listener: Listener): void {
    this.listeners.get(name)?.delete(listener)
  }

  close(): void {
    this.closed = true
  }

  /** The names something listens to right now. */
  listening(): string[] {
    return [...this.listeners].filter(([, set]) => set.size > 0).map(([name]) => name)
  }

  /** The sidecar sends a named frame; `data` is sent as JSON unless it
   *  is a string already. */
  emit(name: string, data: unknown): void {
    if (this.closed) return
    const raw = typeof data === 'string' ? data : JSON.stringify(data)
    for (const listener of this.listeners.get(name) ?? []) {
      listener(new MessageEvent(name, { data: raw }))
    }
  }
}

let created: FakeEventSource[] = []

export interface FakeEventSources {
  /** Every stream opened since install, oldest first. */
  all: () => FakeEventSource[]
  /** The stream opened last; throws if none was. */
  last: () => FakeEventSource
  restore: () => void
}

export function installFakeEventSource(): FakeEventSources {
  created = []
  const had = 'EventSource' in globalThis
  const original = (globalThis as { EventSource?: unknown }).EventSource
  ;(globalThis as { EventSource?: unknown }).EventSource = FakeEventSource
  return {
    all: () => [...created],
    last: () => {
      const source = created[created.length - 1]
      if (!source) throw new Error('fakeEventSource: no stream was opened')
      return source
    },
    restore: () => {
      if (had) (globalThis as { EventSource?: unknown }).EventSource = original
      else delete (globalThis as { EventSource?: unknown }).EventSource
    }
  }
}
