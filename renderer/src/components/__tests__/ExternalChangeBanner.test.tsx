// A model edited the working set through MCP. Whether that is the
// user's problem depends entirely on whether they have unsaved edits
// of their own — and the window used to ask either way.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { useStore } from '../../state'
import { ExternalChangeBanner } from '../ExternalChangeBanner'

const CID = '42'

function seed(opts: { dirty: boolean; origin?: string }) {
  useStore.setState({
    flistActiveCharacterId: CID,
    flistExternalChange: {
      [CID]: {
        setId: 'bench1',
        etag: 'e1',
        origin: opts.origin ?? 'mcp:set_profile_field',
        at: 1000
      }
    } as never,
    flistWorking: {
      [CID]: { unsavedDirty: opts.dirty, payload: {}, overlay: [] }
    } as never
  })
}

beforeEach(() => {
  useStore.setState({
    flistReloadAfterExternalChange: vi.fn().mockResolvedValue(undefined),
    flistOverwriteAfterExternalChange: vi.fn().mockResolvedValue(undefined),
    flistDismissExternalChange: vi.fn()
  } as never)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('reloads by itself when there is nothing to decide', async () => {
  // The change is already on disk. Asking the user to press "Reload"
  // is asking them to confirm a foregone conclusion.
  seed({ dirty: false })
  render(<ExternalChangeBanner />)

  await waitFor(() => {
    expect(useStore.getState().flistReloadAfterExternalChange).toHaveBeenCalledWith(CID)
  })
  expect(screen.queryByTestId('external-change-banner')).toBeNull()
})

it('says which tool did it, since that is the invisible part', async () => {
  seed({ dirty: false })
  render(<ExternalChangeBanner />)

  const note = await screen.findByTestId('external-change-note')
  expect(note.textContent).toContain('set_profile_field')
})

it('still asks when both sides have changes', () => {
  seed({ dirty: true })
  render(<ExternalChangeBanner />)

  const banner = screen.getByTestId('external-change-banner')
  expect(banner.textContent).toContain('one of the two versions has to win')
  expect(screen.getByTestId('external-change-keep')).toBeTruthy()
  // Nothing happens without the user: the window must not quietly
  // discard edits it is holding.
  expect(useStore.getState().flistReloadAfterExternalChange).not.toHaveBeenCalled()
})

it('reloads once, not once per render', async () => {
  seed({ dirty: false })
  const { rerender } = render(<ExternalChangeBanner />)
  rerender(<ExternalChangeBanner />)
  rerender(<ExternalChangeBanner />)

  await waitFor(() => {
    expect(useStore.getState().flistReloadAfterExternalChange).toHaveBeenCalledTimes(1)
  })
})

it('shows nothing at all when nothing changed', () => {
  useStore.setState({
    flistActiveCharacterId: CID,
    flistExternalChange: {} as never,
    flistWorking: {} as never
  })
  const { container } = render(<ExternalChangeBanner />)
  expect(container.firstChild).toBeNull()
})
