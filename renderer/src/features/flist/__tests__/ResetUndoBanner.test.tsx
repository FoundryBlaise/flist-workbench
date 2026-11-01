// The banner after "Reset to Live". Normally it offers a short Undo.
// When the Workbench changed since the reset (a model edited it, or
// the window saved text typed after the reset), the undo has not been
// applied and the banner asks which version to keep instead.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useStore } from '../../../state'
import { ResetUndoBanner } from '../ResetUndoBanner'
import { workingSlot } from '../../../test/payloads'

const CID = '42'

function seed(conflict: boolean) {
  useStore.setState({
    flistResetUndo: {
      characterId: CID,
      snapshot: workingSlot(),
      expiresAt: Date.now() + 5_000,
      etag: 'after-reset',
      awaitingWrite: false,
      conflict
    }
  })
}

beforeEach(() => {
  useStore.setState({
    flistUndoResetWorking: vi.fn().mockResolvedValue(undefined),
    flistDismissResetUndo: vi.fn()
  } as never)
})

afterEach(() => {
  cleanup()
  useStore.setState({ flistResetUndo: null })
  vi.restoreAllMocks()
})

it('offers Undo after a reset', () => {
  seed(false)
  render(<ResetUndoBanner characterId={CID} />)

  fireEvent.click(screen.getByRole('button', { name: /^Undo/ }))

  expect(useStore.getState().flistUndoResetWorking).toHaveBeenCalledWith()
})

it('asks before undoing over a change made since the reset', () => {
  seed(true)
  render(<ResetUndoBanner characterId={CID} />)

  expect(screen.getByTestId('profile-fields-reset-undo').textContent).toMatch(
    /changed since the reset/i
  )
  fireEvent.click(screen.getByRole('button', { name: /keep the change/i }))
  expect(useStore.getState().flistDismissResetUndo).toHaveBeenCalled()
  expect(useStore.getState().flistUndoResetWorking).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('button', { name: /undo anyway/i }))
  expect(useStore.getState().flistUndoResetWorking).toHaveBeenCalledWith({ overwrite: true })
})

it('shows nothing for another character', () => {
  seed(true)
  render(<ResetUndoBanner characterId="7" />)

  expect(screen.queryByTestId('profile-fields-reset-undo')).toBeNull()
})
