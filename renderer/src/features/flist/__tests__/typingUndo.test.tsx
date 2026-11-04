// Typing in the Workbench's text fields on the Profile fields and
// Images tabs and the undo keys (#111): a caption's typing is a burst
// per pause or blur on the Workbench undo stack, and an infotag field
// keeps Ctrl+Z to itself only while it holds typing it has not
// committed yet. Rendered with the real store and the window's
// keydown handler, against the fake sidecar.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useStore } from '../../../state'
import { resetUndoStacks } from '../../../state/undoStack'
import { handleUndoKeydown } from '../../../lib/undoRedo'
import { ImagesTab } from '../ImagesTab'
import { TextField } from '../infotagFields/TextField'
import type { InfotagDescriptor } from '../infotagsResolver'
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
  const species: InfotagDescriptor = {
    id: '9',
    fieldName: 'info_9',
    label: 'Species',
    type: 'text',
    groupId: 'general',
    uiHint: {}
  }

  it('keeps Ctrl+Z to itself while it holds uncommitted typing, and steps the Workbench after', () => {
    seed({ kinks: { '12': 'yes' } })
    store().flistStandardKinkSet(CID, '12', 'fave')
    const onCommit = vi.fn()
    const { rerender } = render(
      <TextField
        descriptor={species}
        value="Human"
        overlaid={false}
        liveValue={null}
        readOnly={false}
        onCommit={onCommit}
        onReset={vi.fn()}
      />
    )
    const input = screen.getByTestId('infotag-9-input')
    input.focus()
    fireEvent.change(input, { target: { value: 'Humane' } })
    expect(ctrl('z', input).defaultPrevented).toBe(false)
    expect(store().flistWorking[CID].payload.kinks).toEqual({ '12': 'fave' })

    fireEvent.blur(input)
    expect(onCommit).toHaveBeenCalledWith('Humane')
    rerender(
      <TextField
        descriptor={species}
        value="Humane"
        overlaid={false}
        liveValue={null}
        readOnly={false}
        onCommit={onCommit}
        onReset={vi.fn()}
      />
    )
    input.focus()
    expect(ctrl('z', input).defaultPrevented).toBe(true)
    expect(store().flistWorking[CID].payload.kinks).toEqual({ '12': 'yes' })
  })
})
