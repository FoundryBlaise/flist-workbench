// Typing in a Profile fields text field while a model changes the
// Workbench: the keystrokes count as mine in the merge, so a model's
// change never wipes them, whether it touched another field or the
// same one (then the window asks). Rendered with the real store, a
// real model event and the fake sidecar.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useStore } from '../../../state'
import { resetUndoStacks } from '../../../state/undoStack'
import { applyWorkbenchEvent } from '../../../state/workbenchEvents'
import { installFakeApi, json, type FakeApi } from '../../../test/fakeApi'
import { payloadRead, workbenchPayload, workingSlot } from '../../../test/payloads'
import { ProfileFieldsTab } from '../ProfileFieldsTab'

const CID = '99'
const BENCH = `/flist/character/${CID}/workbench/payload`

const SAVED = workbenchPayload({
  character: { description: 'as I left her', custom_title: 'the wanderer' },
  infotags: { '9': 'Human' }
})

let fake: FakeApi

const store = () => useStore.getState()
const slot = () => store().flistWorking[CID]
const character = () => slot().payload.character as Record<string, unknown>

/** The model writes `change` over the saved Workbench and its event
 *  arrives. */
async function modelWrites(
  change: (p: { character: Record<string, string>; infotags: Record<string, string> }) => void
) {
  const theirs = JSON.parse(JSON.stringify(SAVED))
  change(theirs)
  fake.on(`GET ${BENCH}`, json(payloadRead(theirs, 'theirs')))
  await act(async () => {
    applyWorkbenchEvent(
      { event: 'set-payload-changed', at: 1, origin: 'mcp:set_profile_field', character_id: CID, etag: 'theirs' },
      store()
    )
    await vi.advanceTimersByTimeAsync(0)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  fake = installFakeApi().fallback(json({ etag: 'saved' }))
  resetUndoStacks()
  useStore.setState({
    mode: 'editor',
    foreignActive: false,
    flistWorking: { [CID]: workingSlot(SAVED) },
    flistExternalChange: {},
    flistMergeQuestion: {},
    flistViewingLive: {},
    flistBrowseBackup: null,
    flistArchive: {},
    flistRoster: [],
    flistDriftBanners: {},
    flistActiveCharacterId: CID,
    editorReadOnly: false,
    flistMapping: {
      status: 'ready',
      payload: {
        _etag: null,
        _fetched_at: null,
        infotags: [{ id: 9, name: 'Species', type: 'text' }],
        listitems: [],
        kinks: []
      },
      fetchedAt: null,
      etag: null,
      error: null
    }
  } as never)
})

afterEach(() => {
  cleanup()
  fake.restore()
  vi.useRealTimers()
})

describe('typing in a Profile fields text field when a model changes the Workbench', () => {
  it('keeps the custom title typed so far when the model changed another field', async () => {
    render(<ProfileFieldsTab characterId={CID} />)
    const title = screen.getByTestId('character-custom-title').querySelector('input') as HTMLInputElement
    title.focus()
    fireEvent.change(title, { target: { value: 'the wanderer, home' } })

    await modelWrites((p) => {
      p.character.description = 'their version of her'
    })

    expect(title.value).toBe('the wanderer, home')
    expect(character()).toEqual({ description: 'their version of her', custom_title: 'the wanderer, home' })
    expect(slot().etag).toBe('theirs')
  })

  it('asks when the model changed the infotag being typed into, and keeps the typing meanwhile', async () => {
    render(<ProfileFieldsTab characterId={CID} />)
    const species = screen.getByTestId('infotag-9-input') as HTMLInputElement
    species.focus()
    fireEvent.change(species, { target: { value: 'Human, mostly' } })

    await modelWrites((p) => {
      p.infotags['9'] = 'Elf'
    })

    expect(species.value).toBe('Human, mostly')
    expect(store().flistMergeQuestion[CID]?.fields).toEqual(['infotags.9'])
  })
})
