// A character on the account that this install has never pulled is not
// in the archive yet, and the sidecar answers its routes with 404
// `character_not_found`. That is "nothing here yet", not a failure: the
// window must show it the way it shows a character with no backups,
// while the first Pull (started on select) brings the character in.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useStore } from '../../state'
import { installFakeApi, json, type FakeApi } from '../../test/fakeApi'

let fake: FakeApi

const notFound = json(
  { code: 'character_not_found', message: 'no such character in the archive' },
  404
)

beforeEach(() => {
  fake = installFakeApi()
  useStore.setState({ flistArchive: {} })
})

afterEach(() => {
  fake.restore()
  vi.restoreAllMocks()
})

it('shows no backups, not an error, for a character never pulled', async () => {
  fake.fallback(notFound)

  await useStore.getState().flistLoadArchive('77')

  const archive = useStore.getState().flistArchive['77']
  expect(archive?.zipBackupsStatus).toBe('ready')
  expect(archive?.zipBackups).toEqual([])
  expect(archive?.live).toBeNull()
})

it('still reports a backups list that fails for another reason', async () => {
  fake.fallback(notFound)
  fake.on('GET /flist/character/77/zip-backups', json({ code: 'internal_error', message: 'disk on fire', details: {} }, 500))

  await useStore.getState().flistLoadArchive('77')

  expect(useStore.getState().flistArchive['77']?.zipBackupsStatus).toBe('error')
})
