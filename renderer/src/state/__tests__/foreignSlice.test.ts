// The Foreign slice: the Foreign profile slot, opened to read someone
// else's profile, refreshed from F-list, left and emptied. Seam: the
// one store against the fake sidecar. The stale-load race is pinned in
// foreignLoad.test.ts.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useStore } from '../../state'
import { foreignInitialState } from '../slices/foreign'
import { installFakeApi, json, type FakeApi } from '../../test/fakeApi'

let fake: FakeApi

const NAME = 'Alpha One'
const READ = `GET /foreign/character/${encodeURIComponent(NAME)}`

function profileAnswer(extra: Record<string, unknown> = {}) {
  return json({
    name: NAME,
    profile: {
      name: NAME,
      id: 1,
      description: 'Their description.',
      custom_title: '',
      infotags: {},
      kinks: {},
      custom_kinks: {},
      images: [],
      fetched_at: 1_700_000_000
    },
    from_cache: true,
    age_sec: 120,
    fetched_at: 1_700_000_000,
    ...extra
  })
}

beforeEach(() => {
  fake = installFakeApi()
  useStore.setState(foreignInitialState())
})

afterEach(() => {
  fake.restore()
})

describe('the slot', () => {
  it('starts empty and not selected', () => {
    const s = useStore.getState()
    expect(s.foreignActive).toBe(false)
    expect(s.foreignName).toBeNull()
    expect(s.foreignProfile).toBeNull()
    expect(s.foreignStatus).toBe('idle')
  })

  it('opening it shows the editor pane and closes cross search', () => {
    useStore.getState().setMode('logs')
    useStore.getState().setCrossSearchOpen(true)

    useStore.getState().foreignOpenSlot()

    const s = useStore.getState()
    expect(s.foreignActive).toBe(true)
    expect(s.mode).toBe('editor')
    expect(s.crossSearchOpen).toBe(false)
  })

  it('leaving it keeps the profile for when it is opened again', async () => {
    fake.on(READ, profileAnswer())
    await useStore.getState().foreignLoad(NAME)

    useStore.getState().foreignLeaveSlot()

    const s = useStore.getState()
    expect(s.foreignActive).toBe(false)
    expect(s.foreignName).toBe(NAME)
    expect(s.foreignStatus).toBe('ready')
  })

  it('emptying it goes back to the lookup form', async () => {
    fake.on(READ, profileAnswer())
    await useStore.getState().foreignLoad(NAME)

    useStore.getState().foreignUnload()

    const s = useStore.getState()
    expect(s.foreignName).toBeNull()
    expect(s.foreignProfile).toBeNull()
    expect(s.foreignStatus).toBe('idle')
  })
})

describe('loading a Foreign profile', () => {
  it('shows the profile with how old the cached copy is', async () => {
    fake.on(READ, profileAnswer())

    await useStore.getState().foreignLoad(`  ${NAME} `)

    const s = useStore.getState()
    expect(fake.requestsTo(READ)).toHaveLength(1)
    expect(s.foreignActive).toBe(true)
    expect(s.foreignName).toBe(NAME)
    expect(s.foreignProfile?.description).toBe('Their description.')
    expect(s.foreignFromCache).toBe(true)
    expect(s.foreignAgeSec).toBe(120)
    expect(s.foreignStale).toBe(false)
    expect(s.foreignStatus).toBe('ready')
  })

  it('a refresh asks F-list again; a failed one shows the cached copy as stale', async () => {
    fake.on(
      `${READ}?refresh=true`,
      profileAnswer({ stale: true, refresh_error: 'F-list did not answer.' })
    )

    await useStore.getState().foreignLoad(NAME, true)

    const s = useStore.getState()
    expect(fake.requestsTo(`${READ}?refresh=true`)).toHaveLength(1)
    expect(s.foreignStale).toBe(true)
    expect(s.foreignRefreshError).toBe('F-list did not answer.')
    expect(s.foreignStatus).toBe('ready')
  })

  it('an empty name reads nothing', async () => {
    await useStore.getState().foreignLoad('   ')

    expect(fake.requests).toEqual([])
    expect(useStore.getState().foreignStatus).toBe('idle')
  })

  it('a name F-list will not show is said in plain words', async () => {
    fake.on(READ, json({ code: 'not_found', message: 'Not found.', details: {} }, 404))

    await useStore.getState().foreignLoad(NAME)

    const s = useStore.getState()
    expect(s.foreignStatus).toBe('error')
    expect(s.foreignError).toBe(
      `F-list will not show "${NAME}": there is no character by that name, ` +
        'or it was deleted, is private or blocks your account.'
    )
  })

  it('any other refusal shows the sidecar’s own words', async () => {
    fake.on(
      READ,
      json({ code: 'flist_unreachable', message: 'F-list cannot be reached.', details: {} }, 502)
    )

    await useStore.getState().foreignLoad(NAME)

    expect(useStore.getState().foreignError).toBe('F-list cannot be reached.')
  })
})
