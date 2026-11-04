// The short note the window shows after it took another writer's change
// in by itself, or after Ctrl+Z / Ctrl+Y stepped over one. It
// names the writer, since that is the part the user cannot see.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { useStore } from '../../state'
import type { CommitLabel } from '../../state/commit'
import { WorkbenchNote } from '../WorkbenchNote'

const CID = '42'

function note(action: 'updated' | 'undo' | 'redo', label: CommitLabel, characterId = CID) {
  useStore.setState({ flistWorkbenchNote: { characterId, action, label, at: 1000 } })
}

const text = () => screen.queryByTestId('workbench-note')?.textContent ?? null

beforeEach(() => {
  vi.useFakeTimers()
  useStore.setState({ flistActiveCharacterId: CID, flistWorkbenchNote: null })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('names the tool whose change an undo took back', () => {
  note('undo', 'mcp:set_description')
  render(<WorkbenchNote />)
  expect(text()).toContain('Undid the change by a connected model — set_description.')
})

it('names the tool whose change a redo applied again', () => {
  note('redo', 'mcp:set_profile_field')
  render(<WorkbenchNote />)
  expect(text()).toContain('Redid the change by a connected model — set_profile_field.')
})

it('says who changed the Workbench when the window took it in by itself', () => {
  note('updated', 'mcp:set_description')
  render(<WorkbenchNote />)
  expect(text()).toContain('Updated by a connected model — set_description.')
})

it('says nothing when a maintenance pass changed the Workbench, but names it when undone', () => {
  // The app's own passes run after most Pulls; a note each time is noise.
  note('updated', 'internal:gallery-repair')
  const { rerender } = render(<WorkbenchNote />)
  expect(text()).toBeNull()

  note('undo', 'internal:gallery-repair')
  rerender(<WorkbenchNote />)
  expect(text()).toContain('Undid the change by a maintenance pass in the app (gallery repair).')
})

it('names a Restore and a reset to Live, and says nothing for the user’s own edits', () => {
  note('undo', 'restore')
  const { rerender } = render(<WorkbenchNote />)
  expect(text()).toContain('Undid the Restore.')

  note('redo', 'reset-to-live')
  rerender(<WorkbenchNote />)
  expect(text()).toContain('Redid the reset to Live.')

  note('undo', 'edit')
  rerender(<WorkbenchNote />)
  expect(text()).toBeNull()
})

it('shows nothing for a character the window is not showing', () => {
  note('undo', 'mcp:set_description', '7')
  render(<WorkbenchNote />)
  expect(text()).toBeNull()
})

it('fades on its own', () => {
  note('undo', 'mcp:set_description')
  render(<WorkbenchNote />)
  expect(text()).not.toBeNull()
  act(() => {
    vi.advanceTimersByTime(8000)
  })
  expect(text()).toBeNull()
})
