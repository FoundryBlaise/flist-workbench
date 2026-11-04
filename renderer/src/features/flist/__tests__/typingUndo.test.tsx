// Typing in the Workbench's text fields on the Profile fields and
// Images tabs and the undo keys (#111): a caption's typing is a burst
// per pause or blur on the Workbench undo stack, and so is an infotag
// field's. Rendered with the real store and the window's
// keydown handler, against the fake sidecar.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useStore } from '../../../state'
import { resetUndoStacks } from '../../../state/undoStack'
import { handleUndoKeydown } from '../../../lib/undoRedo'
import { ImagesTab } from '../ImagesTab'
import { ProfileFieldsTab } from '../ProfileFieldsTab'
import { installFakeApi, json, type FakeApi } from '../../../test/fakeApi'
import { workbenchPayload, workingSlot } from '../../../test/payloads'

const CID = '42'
const IMAGES = `/flist/character/${CID}/images`

let fake: FakeApi

const store = () => useStore.getState()
const captionOf = (imageId: string) =>
  (store().flistWorking[CID].payload.images as { image_id: string; description: string }[]).find(
    (e) => e.image_id === imageId
  )?.description

function seed(payload: Record<string, unknown>) {
  useStore.setState({
    mode: 'editor',
    foreignActive: false,
    flistWorking: { [CID]: workingSlot(workbenchPayload(payload)) },
    flistViewingLive: {},
    flistBrowseBackup: null,
    flistActiveCharacterId: CID,
    editorReadOnly: false,
    flistCharacterImages: {
      [CID]: { byId: { a: { extension: 'png', size: 1, added_at: 1 } }, status: 'ready' }
    },
    flistRoster: []
  } as never)
}

function ctrl(key: string, target: Element) {
  const e = new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true })
  target.dispatchEvent(e)
  return e
}

beforeEach(() => {
  resetUndoStacks()
  fake = installFakeApi()
    .on(`POST ${IMAGES}/repair`, json({ repaired: false }))
    .on(`GET ${IMAGES}`, json({ character_id: CID, images: [] }))
    .on(`GET /flist/character/${CID}/image-references`, json({}))
    .fallback(json({ etag: 'e1' }))
  document.addEventListener('keydown', handleUndoKeydown)
})

afterEach(() => {
  cleanup()
  document.removeEventListener('keydown', handleUndoKeydown)
  fake.restore()
  vi.restoreAllMocks()
})

describe('a caption on the Images tab', () => {
  it('typing is one undo entry up to blur, and Ctrl+Z in the caption undoes it', () => {
    seed({ images: [{ image_id: 'a', description: '', sort_order: 0 }] })
    render(<ImagesTab characterId={CID} />)
    const caption = screen.getByPlaceholderText('(no description)')
    caption.focus()
    for (const text of ['S', 'Se', 'Sea']) fireEvent.change(caption, { target: { value: text } })
    fireEvent.blur(caption)
    caption.focus()
    fireEvent.change(caption, { target: { value: 'Sea!' } })

    expect(ctrl('z', caption).defaultPrevented).toBe(true)
    expect(captionOf('a')).toBe('Sea')
    ctrl('z', caption)
    expect(captionOf('a')).toBe('')
    ctrl('y', caption)
    expect(captionOf('a')).toBe('Sea')
  })
})

describe('an infotag text field', () => {
  it('typing is one undo entry up to blur, and Ctrl+Z in the field undoes it', () => {
    seed({ infotags: { '9': 'Human' } })
    useStore.setState({
      flistArchive: {},
      flistDriftBanners: {},
      flistMapping: {
        status: 'ready',
        payload: { _etag: null, _fetched_at: null, infotags: [{ id: 9, name: 'Species', type: 'text' }], listitems: [], kinks: [] },
        fetchedAt: null,
        etag: null,
        error: null
      }
    } as never)
    render(<ProfileFieldsTab characterId={CID} />)
    const input = screen.getByTestId('infotag-9-input') as HTMLInputElement
    const species = () => (store().flistWorking[CID].payload.infotags as Record<string, string>)['9']
    input.focus()
    for (const text of ['Human,', 'Human, m', 'Human, mostly']) fireEvent.change(input, { target: { value: text } })
    fireEvent.blur(input)
    input.focus()
    fireEvent.change(input, { target: { value: 'Human, mostly!' } })

    let undo: KeyboardEvent | undefined
    act(() => {
      undo = ctrl('z', input)
    })
    expect(undo?.defaultPrevented).toBe(true)
    expect(species()).toBe('Human, mostly')
    expect(input.value).toBe('Human, mostly')
    ctrl('z', input)
    expect(species()).toBe('Human')
    ctrl('y', input)
    expect(species()).toBe('Human, mostly')
  })
})
