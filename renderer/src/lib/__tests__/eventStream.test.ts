// The window's subscription to the sidecar's change broadcast. The
// sidecar names every frame, so an event the subscription does not
// listen for never reaches the window at all.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { subscribeToWorkbenchEvents, type WorkbenchEvent } from '../eventStream'
import { installFakeEventSource, type FakeEventSources } from '../../test/fakeEventSource'

let sources: FakeEventSources

beforeEach(() => {
  sources = installFakeEventSource()
})

afterEach(() => {
  sources.restore()
})

const BASE = 'http://127.0.0.1:27384'

function frame(event: string, extra: Partial<WorkbenchEvent> = {}): WorkbenchEvent {
  return { event, at: 1, origin: 'mcp:set_description', character_id: '99', ...extra }
}

it('opens the sidecar’s /events stream', () => {
  subscribeToWorkbenchEvents(BASE, () => {})
  expect(sources.last().url).toBe(`${BASE}/events`)
})

it('hands on a model’s change to the Workbench with its etag', () => {
  const seen: WorkbenchEvent[] = []
  subscribeToWorkbenchEvents(BASE, (e) => seen.push(e))
  sources.last().emit('set-payload-changed', frame('set-payload-changed', { etag: 'theirs' }))
  expect(seen).toEqual([frame('set-payload-changed', { etag: 'theirs' })])
})

it('listens for every event the sidecar publishes', () => {
  subscribeToWorkbenchEvents(BASE, () => {})
  expect(sources.last().listening().sort()).toEqual(
    [
      'backups-changed',
      'characters-changed',
      'images-changed',
      'index-changed',
      'labels-changed',
      'live-changed',
      'set-payload-changed',
      'sets-changed',
      'settings-changed'
    ].sort()
  )
})

it('drops a frame that is not an event', () => {
  const onEvent = vi.fn()
  subscribeToWorkbenchEvents(BASE, onEvent)
  sources.last().emit('set-payload-changed', 'not json')
  sources.last().emit('set-payload-changed', { at: 1 })
  expect(onEvent).not.toHaveBeenCalled()
})

it('closing stops listening and closes the stream', () => {
  const onEvent = vi.fn()
  const close = subscribeToWorkbenchEvents(BASE, onEvent)
  const source = sources.last()
  close()
  expect(source.closed).toBe(true)
  expect(source.listening()).toEqual([])
})
