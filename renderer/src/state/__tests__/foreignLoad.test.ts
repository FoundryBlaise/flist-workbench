// Loading a Foreign profile into the slot. Each load carries a request
// token, so when the user picks quickly the view always ends on the
// profile picked last, whatever order F-list's answers arrive in.
//
// The reads are held on the shared fake sidecar and released out of
// order to stage the race.

import { afterEach, beforeEach, expect, it } from 'vitest'
import { useStore } from '../../state'
import { installFakeApi, json, type FakeApi } from '../../test/fakeApi'

let fake: FakeApi

const PROFILE_READ = /^GET \/foreign\/character\//

function profileOf(name: string, id: number) {
  return {
    name,
    id,
    description: `${name}'s description.`,
    custom_title: '',
    infotags: {},
    kinks: {},
    custom_kinks: {},
    images: [],
    fetched_at: 1_700_000_000
  }
}

function answer(name: string, id: number) {
  return json({
    name,
    profile: profileOf(name, id),
    from_cache: false,
    age_sec: 0,
    fetched_at: 1_700_000_000
  })
}

/** The held read for `name`, still waiting on its answer. */
function heldReadOf(name: string) {
  const hit = fake
    .pending(PROFILE_READ)
    .find((p) => p.request.path.startsWith(`/foreign/character/${encodeURIComponent(name)}`))
  if (!hit) throw new Error(`no held read for ${name}`)
  return hit
}

beforeEach(() => {
  fake = installFakeApi().hold(PROFILE_READ)
  useStore.setState({
    foreignActive: true,
    foreignName: null,
    foreignProfile: null,
    foreignFromCache: false,
    foreignAgeSec: null,
    foreignStale: false,
    foreignRefreshError: null,
    foreignStatus: 'idle',
    foreignError: null
  })
})

afterEach(() => {
  fake.restore()
})

it('picking A then B shows B when A answers last', async () => {
  const loadA = useStore.getState().foreignLoad('Alpha One')
  const loadB = useStore.getState().foreignLoad('Beta Two')

  heldReadOf('Beta Two').resolve(answer('Beta Two', 2))
  await loadB
  heldReadOf('Alpha One').resolve(answer('Alpha One', 1))
  await loadA

  const s = useStore.getState()
  expect(s.foreignName).toBe('Beta Two')
  expect(s.foreignProfile?.description).toBe("Beta Two's description.")
  expect(s.foreignStatus).toBe('ready')
})

it('a late failure of A leaves B on screen', async () => {
  const loadA = useStore.getState().foreignLoad('Alpha One')
  const loadB = useStore.getState().foreignLoad('Beta Two')

  heldReadOf('Beta Two').resolve(answer('Beta Two', 2))
  await loadB
  heldReadOf('Alpha One').resolve(
    json({ code: 'not_found', message: 'No such character.' }, 404)
  )
  await loadA

  const s = useStore.getState()
  expect(s.foreignName).toBe('Beta Two')
  expect(s.foreignStatus).toBe('ready')
  expect(s.foreignError).toBeNull()
})

it('emptying the slot while A loads keeps it empty when A answers', async () => {
  const loadA = useStore.getState().foreignLoad('Alpha One')
  useStore.getState().foreignUnload()

  heldReadOf('Alpha One').resolve(answer('Alpha One', 1))
  await loadA

  const s = useStore.getState()
  expect(s.foreignName).toBeNull()
  expect(s.foreignProfile).toBeNull()
  expect(s.foreignStatus).toBe('idle')
})
