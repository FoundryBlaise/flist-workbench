// The Archive slice: a character's Live, its Pulls, its Backups and
// Back up all, its Pool and its Trash. Seam: the one store, against the
// fake sidecar, asserting what the store holds and what it asked.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../../state'
import { archiveInitialState } from '../slices/archive'
import { installFakeApi, json, type FakeApi } from '../../test/fakeApi'

const CID = '42'
const BASE = `/flist/character/${CID}`

let fake: FakeApi

beforeEach(() => {
  fake = installFakeApi()
  useStore.setState(archiveInitialState())
})

afterEach(() => {
  fake.restore()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('the Pool', () => {
  it('lists the image files the sidecar keeps for the character', async () => {
    fake.on(
      `GET ${BASE}/images`,
      json({
        character_id: CID,
        images: [
          { image_id: '1001', extension: 'png', size: 10, added_at: 5 },
          { image_id: 'local-ab12cd34', extension: 'jpg', size: 20 }
        ]
      })
    )

    await useStore.getState().flistLoadCharacterImages(CID)

    expect(useStore.getState().flistCharacterImages[CID]).toEqual({
      byId: {
        '1001': { extension: 'png', size: 10, added_at: 5 },
        'local-ab12cd34': { extension: 'jpg', size: 20, added_at: undefined }
      },
      status: 'ready'
    })
  })
})
