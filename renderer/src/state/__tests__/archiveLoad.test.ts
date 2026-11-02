// Opening a character loads what the window shows of its archive: Live
// and the Backups. Seam: the store, against the fake sidecar.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useStore } from '../../state'
import { installFakeApi, json, type FakeApi } from '../../test/fakeApi'
import { livePayload } from '../../test/payloads'

let fake: FakeApi

beforeEach(() => {
  fake = installFakeApi()
  useStore.setState({ flistArchive: {} })
})

afterEach(() => {
  fake.restore()
  vi.restoreAllMocks()
})

it('reads Live and the Backups, and nothing else', async () => {
  fake.on('GET /flist/character/77/live', json(livePayload()))
  fake.on('GET /flist/character/77/zip-backups', json({ backups: [] }))

  await useStore.getState().flistLoadArchive('77')

  expect(fake.requests.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
    'GET /flist/character/77/live',
    'GET /flist/character/77/zip-backups'
  ])
  const archive = useStore.getState().flistArchive['77']
  expect(archive?.live).not.toBeNull()
  expect(archive?.zipBackupsStatus).toBe('ready')
})
