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

function event(name: string, origin = 'mcp:create_backup'): WorkbenchEvent {
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

it('a Pull reloads Live and the Backups', async () => {
  expect(await rereads(event('live-changed', 'extension'))).toEqual([
    'GET /flist/character/77/live',
    'GET /flist/character/77/zip-backups'
  ])
})

it('images another writer changed reload the pool', async () => {
  expect(await rereads(event('images-changed', 'mcp:import_images'))).toEqual([
    'GET /flist/character/77/images'
  ])
})

it('the window’s own writes reload nothing', async () => {
  for (const name of ['backups-changed', 'characters-changed', 'images-changed', 'live-changed']) {
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
