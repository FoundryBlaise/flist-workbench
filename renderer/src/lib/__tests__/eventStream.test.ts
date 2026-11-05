// The window's subscription to the sidecar's change broadcast, through
// the request function like every other route. The sidecar names every
// frame, so an event the subscription does not handle never reaches the
// window at all. The stream is opened again whenever it ends or cannot
// be reached: a sidecar restarted mid-session must not leave the window
// blind.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { subscribeToWorkbenchEvents, type WorkbenchEvent } from '../eventStream'
import { installFakeApi, json, networkError, type FakeApi } from '../../test/fakeApi'

const EVENTS = 'GET /events'

let fake: FakeApi
let close: (() => void) | null

beforeEach(() => {
  fake = installFakeApi()
  close = null
})

afterEach(() => {
  close?.()
  fake.restore()
})

function frame(event: WorkbenchEvent['event'], extra: Partial<WorkbenchEvent> = {}): WorkbenchEvent {
  return { event, at: 1, origin: 'mcp:set_description', character_id: '99', ...extra }
}

/** Subscribe, retrying at once, and wait for the `n`th stream. */
async function subscribe(onEvent: (e: WorkbenchEvent) => void, n = 1) {
  close = subscribeToWorkbenchEvents(onEvent, { reconnectMs: 1 })
  await vi.waitFor(() => expect(fake.streams(EVENTS)).toHaveLength(n))
  return fake.streams(EVENTS)[n - 1]
}

it('opens the sidecar’s /events stream through the request function', async () => {
  fake.stream(EVENTS)
  const stream = await subscribe(() => {})
  expect(stream.request.path).toBe('/events')
  expect(stream.request.headers.Accept).toBe('text/event-stream')
})

it('hands on a model’s change to the Workbench with its etag', async () => {
  fake.stream(EVENTS)
  const seen: WorkbenchEvent[] = []
  const stream = await subscribe((e) => seen.push(e))

  stream.send('set-payload-changed', frame('set-payload-changed', { etag: 'theirs' }))

  await vi.waitFor(() => expect(seen).toEqual([frame('set-payload-changed', { etag: 'theirs' })]))
})

it('hands on every event the sidecar publishes, and not `ready`', async () => {
  fake.stream(EVENTS)
  const seen: string[] = []
  const stream = await subscribe((e) => seen.push(e.event))
  const names: WorkbenchEvent['event'][] = [
    'backups-changed',
    'characters-changed',
    'images-changed',
    'index-changed',
    'labels-changed',
    'live-changed',
    'set-payload-changed',
    'sets-changed',
    'settings-changed'
  ]

  stream.send('ready', { subscribers: 1 })
  for (const name of names) stream.send(name, frame(name))

  await vi.waitFor(() => expect(seen).toEqual(names))
})

it('drops a frame that is not an event', async () => {
  fake.stream(EVENTS)
  const onEvent = vi.fn()
  const stream = await subscribe(onEvent)

  stream.send('set-payload-changed', 'not json')
  stream.send('set-payload-changed', { at: 1 })
  stream.send('live-changed', frame('live-changed'))

  await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(1))
  expect(onEvent).toHaveBeenCalledWith(frame('live-changed'))
})

it('closing ends the stream and opens no other', async () => {
  fake.stream(EVENTS)
  const onEvent = vi.fn()
  const stream = await subscribe(onEvent)

  close?.()
  close = null
  stream.send('live-changed', frame('live-changed'))
  await new Promise((r) => setTimeout(r, 10))

  expect(stream.closed).toBe(true)
  expect(onEvent).not.toHaveBeenCalled()
  expect(fake.streams(EVENTS)).toHaveLength(1)
})

it('opens the stream again when the sidecar ends it', async () => {
  fake.stream(EVENTS)
  const seen: WorkbenchEvent[] = []
  const first = await subscribe((e) => seen.push(e))

  first.end()
  const second = await vi.waitFor(() => {
    expect(fake.streams(EVENTS)).toHaveLength(2)
    return fake.streams(EVENTS)[1]
  })
  second.send('live-changed', frame('live-changed'))

  await vi.waitFor(() => expect(seen).toEqual([frame('live-changed')]))
})

it('opens the stream again when the sidecar could not be reached or refused it', async () => {
  fake.once(EVENTS, networkError())
  fake.once(EVENTS, json({ code: 'internal_error', message: 'restarting', details: {} }, 500))
  fake.stream(EVENTS)
  const seen: WorkbenchEvent[] = []
  const stream = await subscribe((e) => seen.push(e))

  stream.send('live-changed', frame('live-changed'))

  await vi.waitFor(() => expect(seen).toEqual([frame('live-changed')]))
  expect(fake.requestsTo(EVENTS)).toHaveLength(3)
})
