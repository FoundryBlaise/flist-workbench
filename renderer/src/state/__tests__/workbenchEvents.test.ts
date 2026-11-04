// The window re-reads what another writer changed: a model over MCP,
// the paired extension, the sidecar's own maintenance. Seam: the
// store, against the fake sidecar; an event goes in, the re-reads the
// window makes come out.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useStore } from '../../state'
import { installFakeApi, json, type FakeApi } from '../../test/fakeApi'
import { livePayload } from '../../test/payloads'
import type { WorkbenchEvent } from '../../lib/eventStream'
import { applyWorkbenchEvent } from '../workbenchEvents'

let fake: FakeApi

beforeEach(() => {
  fake = installFakeApi()
  fake.on('GET /flist/character/77/live', json(livePayload()))
  fake.on('GET /flist/character/77/zip-backups', json({ backups: [] }))
  fake.on('GET /flist/character/77/images', json({ character_id: '77', images: [] }))
  fake.on('GET /flist/characters', json({ characters: [] }))
  useStore.setState({ flistArchive: {}, flistCharacterImages: {} })
})

afterEach(() => {
  fake.restore()
  vi.restoreAllMocks()
})

function event(name: WorkbenchEvent['event'], origin = 'mcp:create_backup'): WorkbenchEvent {
  return { event: name, at: 1, origin, character_id: '77' }
}

/** The re-reads an event set off, once they have all gone out. */
async function rereads(e: WorkbenchEvent): Promise<string[]> {
  applyWorkbenchEvent(e, useStore.getState())
  await vi.waitFor(() => expect(fake.requests.length).toBeGreaterThan(0))
  await new Promise((r) => setTimeout(r, 0))
  return fake.requests.map((r) => `${r.method} ${r.path}`).sort()
}

it('a Backup another writer made reloads the Backup list and the Trash', async () => {
  // The Trash view lists the character's Backups and re-reads with the pool.
  expect(await rereads(event('backups-changed'))).toEqual([
    'GET /flist/character/77/images',
    'GET /flist/character/77/zip-backups'
  ])
})

it('a character coming into the archive reloads the character list', async () => {
  expect(await rereads(event('characters-changed', 'extension'))).toEqual([
    'GET /flist/characters'
  ])
})

it('a Pull reloads Live, the Backups and the character list’s pull status', async () => {
  // The roster row's badge says whether the last Pull got every image.
  expect(await rereads(event('live-changed', 'extension'))).toEqual([
    'GET /flist/character/77/live',
    'GET /flist/character/77/zip-backups',
    'GET /flist/characters'
  ])
})

it('images another writer changed reload the pool', async () => {
  expect(await rereads(event('images-changed', 'mcp:import_images'))).toEqual([
    'GET /flist/character/77/images'
  ])
})

it('the window’s own writes reload nothing', async () => {
  for (const name of ['backups-changed', 'characters-changed', 'images-changed', 'live-changed'] as const) {
    applyWorkbenchEvent(event(name, 'ui'), useStore.getState())
  }
  await new Promise((r) => setTimeout(r, 0))
  expect(fake.requests).toEqual([])
})

it('the new Backup list replaces the one shown', async () => {
  useStore.setState({
    flistArchive: { '77': { live: null, pullStatus: 'idle', zipBackups: [], zipBackupsStatus: 'ready' } }
  })
  const backup = {
    filename: '2026-11-02T120000Z.zip',
    name: null,
    created_at: 1,
    size: 10,
    kind: 'manual_single'
  }
  fake.on('GET /flist/character/77/zip-backups', json({ backups: [backup] }))

  await rereads(event('backups-changed'))

  await vi.waitFor(() =>
    expect(useStore.getState().flistArchive['77']?.zipBackups?.map((b) => b.filename)).toEqual([
      backup.filename
    ])
  )
})

it('an ingest or a wipe another writer started makes the Index status read again', () => {
  useStore.setState({ indexRevision: 0 })

  applyWorkbenchEvent(
    { event: 'index-changed', at: 1, origin: 'mcp:ingest_logs' },
    useStore.getState()
  )

  expect(useStore.getState().indexRevision).toBe(1)
})

function settingsChanged(changed: Record<string, unknown>, origin = 'mcp:update_settings') {
  return { event: 'settings-changed', at: 1, origin, changed } satisfies WorkbenchEvent
}

async function withOpenLog(): Promise<void> {
  useStore.setState({
    activeCharacter: 'Corin Vale',
    activePartner: 'Daelan Envale',
    messagesByPartner: {},
    messagesStatus: {},
    messagesError: {}
  })
  fake.on('GET /logs/messages', json({ messages: [] }))
  await useStore.getState().loadMessages('Corin Vale', 'Daelan Envale')
  expect(fake.requestsTo('GET /logs/messages')).toHaveLength(1)
}

it('an OOC threshold a model changed re-reads the open Log and Settings', async () => {
  await withOpenLog()
  const revision = useStore.getState().settingsRevision

  applyWorkbenchEvent(settingsChanged({ 'labels.threshold_chars': 400 }), useStore.getState())

  expect(useStore.getState().settingsRevision).toBe(revision + 1)
  await expect.poll(() => fake.requestsTo('GET /logs/messages').length).toBe(2)
})

it('search settings a model changed re-read Settings but leave the open Log alone', async () => {
  await withOpenLog()
  const revision = useStore.getState().settingsRevision

  applyWorkbenchEvent(settingsChanged({ 'rag.top_k': 8 }), useStore.getState())
  await new Promise((r) => setTimeout(r, 20))

  expect(useStore.getState().settingsRevision).toBe(revision + 1)
  expect(fake.requestsTo('GET /logs/messages')).toHaveLength(1)
})

it('the window’s own settings and Index changes re-read nothing', () => {
  useStore.setState({ indexRevision: 0 })
  const revision = useStore.getState().settingsRevision

  applyWorkbenchEvent(settingsChanged({ 'rag.top_k': 8 }, 'ui'), useStore.getState())
  applyWorkbenchEvent({ event: 'index-changed', at: 1, origin: 'ui' }, useStore.getState())

  expect(useStore.getState().settingsRevision).toBe(revision)
  expect(useStore.getState().indexRevision).toBe(0)
})
