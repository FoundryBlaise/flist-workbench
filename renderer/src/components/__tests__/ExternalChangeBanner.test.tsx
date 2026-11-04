// A model edited the Workbench through MCP. Whether that is the
// user's problem depends entirely on whether they have unsaved edits
// of their own — and the window used to ask either way.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { useStore } from '../../state'
import { ExternalChangeBanner } from '../ExternalChangeBanner'

const CID = '42'

function seed(opts: { dirty: boolean; origin?: string }) {
  useStore.setState({
    flistActiveCharacterId: CID,
    flistExternalChange: {
      [CID]: {
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

it('leaves a change with nothing unsaved to the store', () => {
  // The store takes it in by itself (state/__tests__/modelChange.test.ts);
  // the banner is only for the case with something to decide.
  seed({ dirty: false })
  const { container } = render(<ExternalChangeBanner />)

  expect(container.firstChild).toBeNull()
  expect(useStore.getState().flistReloadAfterExternalChange).not.toHaveBeenCalled()
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

it('names the app\'s own maintenance pass as the writer', async () => {
  // The silent set-rewrites a pull or an Images-tab listing can trigger
  // (gallery repair, image-id folding) now arrive attributed instead of
  // looking like the window's own write — which is what turns a later
  // "Someone else changed this set" into a plain explanation.
  seed({ dirty: true, origin: 'internal:gallery-repair' })
  render(<ExternalChangeBanner />)

  const banner = screen.getByTestId('external-change-banner')
  expect(banner.textContent).toContain(
    'maintenance pass in the app (gallery repair)'
  )
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
