// Signing in to F-list through the store, against a fake sidecar.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../../state'
import { installFakeApi, json, type FakeApi } from '../../test/fakeApi'

let fake: FakeApi

beforeEach(() => {
  fake = installFakeApi()
  useStore.setState({
    flistSignInAttempt: { status: 'idle' },
    flistSignInOpen: true,
    flistActiveCharacterId: null
  })
})

afterEach(() => {
  fake.restore()
  vi.restoreAllMocks()
})

describe('flistSignIn', () => {
  it('signs in without starting a Back up all of its own', async () => {
    fake
      .on(
        'POST /flist/session',
        json({ characters: [], expires_in_sec: 1800, account: 'Quill Account' })
      )
      .on('GET /flist/characters', json({ characters: [] }))
      // Settings carry no backup schedule any more.
      .on('GET /settings', json({ fchat_data_dir: null, image_import_roots: [] }))

    await useStore.getState().flistSignIn('Quill Account', 'pw')
    await vi.waitFor(() => expect(useStore.getState().flistSignInOpen).toBe(false))

    expect(useStore.getState().flistSignInAttempt.status).toBe('idle')
    expect(useStore.getState().flistSession.active).toBe(true)
    expect(fake.requestsTo('POST /flist/backup-all')).toEqual([])
  })
})
