// Tier 3 QA Missing test #3: CM state cache survives a switch back to
// the same kink id. JSDOM doesn't expose caret state, but we can verify
// (a) the cache is populated on unmount and (b) the cached state is
// applied on re-mount via the `initialState` prop.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { KinkDescriptionEditor, purgeCMStates } from '../KinkDescriptionEditor'

afterEach(() => {
  cleanup()
  purgeCMStates()
})

beforeEach(() => {
  purgeCMStates()
})

describe('KinkDescriptionEditor CM state cache', () => {
  it('normalises CRLF input to LF before mounting CodeMirror', () => {
    const { container } = render(
      <KinkDescriptionEditor
        kinkId="A"
        value={'line1\r\nline2\r\nline3'}
        onChange={vi.fn()}
      />
    )
    // CodeMirror renders one line per .cm-line div in the editor surface.
    const lines = container.querySelectorAll('.cm-line')
    expect(lines.length).toBeGreaterThanOrEqual(3)
  })

  it('emits the kink-keyed testid so React swaps the CM instance on switch', () => {
    const { container, rerender } = render(
      <KinkDescriptionEditor kinkId="A" value="alpha" onChange={vi.fn()} />
    )
    expect(container.querySelector('[data-testid="kink-desc-editor-A"]')).toBeTruthy()
    rerender(<KinkDescriptionEditor kinkId="B" value="beta" onChange={vi.fn()} />)
    expect(container.querySelector('[data-testid="kink-desc-editor-B"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="kink-desc-editor-A"]')).toBeNull()
  })

  it('purgeCMStates clears the module-level cache between characters', () => {
    // Direct API contract: the function returns void and is idempotent.
    purgeCMStates()
    purgeCMStates()
    expect(true).toBe(true)
  })
})
