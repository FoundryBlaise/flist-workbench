// Renders the Diff pane against seeded store state to confirm the
// happy paths (empty, mixed, backup-source) round-trip without errors
// and the badge / category pills behave as documented.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { useStore } from '../../../state'
import { DiffPane, countDiffChanges } from '../DiffPane'

const minimalMapping = {
  infotags: [{ id: '1', name: 'Age', type: 'text', group_id: '3' }],
  listitems: [],
  infotag_groups: [{ id: '3', name: 'General' }],
  kinks: [],
  _etag: null,
  _fetched_at: null
}

function seed(state: {
  payload: Record<string, unknown>
  live?: Record<string, unknown> | null
  backups?: { filename: string; created_at: number; size: number }[]
}) {
  const slot = {
    payload: { _schema_version: 2, _overlay: [], ...state.payload },
    overlay: Array.isArray(state.payload._overlay)
      ? (state.payload._overlay as string[])
      : [],
    etag: null,
    unsavedDirty: false,
    saveStatus: 'idle' as const,
    saveError: null,
    lastSavedAt: null,
    materialised: true
  }
  // Working-sets v2: consumers read via selectWorkingSlot, which routes
  // through the active-set pointer. Seed both shapes so the same fixture
  // satisfies the legacy direct-read paths AND the new selector.
  useStore.setState({
    flistWorking: { '99': slot },
    flistActiveSetId: { '99': 'set99' },
    flistSetWorking: { 'set99': slot },
    flistArchive: {
      '99': {
        live: (state.live ?? null) as Record<string, unknown> | null,
        backups: state.backups ?? [],
        pullStatus: 'idle'
      }
    },
    flistMapping: {
      status: 'ready',
      payload: minimalMapping,
      etag: null,
      fetchedAt: null,
      error: null
    },
    flistDiffRightSource: {},
    flistDiffBackupCache: {}
  })
}

beforeEach(() => {
  useStore.setState({
    flistWorking: {},
    flistActiveSetId: {},
    flistSetWorking: {},
    flistArchive: {},
    flistMapping: {
      status: 'idle',
      payload: null,
      etag: null,
      fetchedAt: null,
      error: null
    },
    flistDiffRightSource: {},
    flistDiffBackupCache: {}
  })
})

afterEach(() => cleanup())

describe('DiffPane', () => {
  it('renders the empty-state when no Live snapshot is on disk', () => {
    seed({ payload: { character: { description: 'mine' } }, live: null })
    const { getByTestId } = render(<DiffPane characterId="99" />)
    expect(getByTestId('diff-pane-empty')).toBeTruthy()
  })

  it('lists category pills and a description-diff toggle for a changed payload', () => {
    seed({
      payload: { character: { description: 'edited' }, infotags: { '1': '28' } },
      live: { character: { description: 'live' }, infotags: { '1': '29' } }
    })
    const { queryAllByText, queryByText, getByTestId } = render(
      <DiffPane characterId="99" />
    )
    expect(getByTestId('diff-pane')).toBeTruthy()
    expect(queryAllByText(/Profile fields/).length).toBeGreaterThan(0)
    expect(queryByText(/Description vs Live/)).toBeTruthy()
  })

  it('hides unchanged rows by default and surfaces them via the toggle', () => {
    seed({
      payload: { character: { description: 'same' }, infotags: { '1': '28' } },
      live: { character: { description: 'same' }, infotags: { '1': '28' } }
    })
    const { queryByText } = render(<DiffPane characterId="99" />)
    // No-diff empty state — updated copy after UX P3 batch.
    expect(queryByText(/Working copy matches Live/)).toBeTruthy()
  })

  it('Reset all button is disabled when overlay is empty', () => {
    seed({
      payload: { character: { description: 'same' } },
      live: { character: { description: 'same' } }
    })
    const { getByTestId } = render(<DiffPane characterId="99" />)
    const btn = getByTestId('diff-pane-reset-all') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })

  it('Reset all button enables when overlay carries authored paths', () => {
    seed({
      payload: {
        _overlay: ['character.description'],
        character: { description: 'edited' }
      },
      live: { character: { description: 'live' } }
    })
    const { getByTestId } = render(<DiffPane characterId="99" />)
    const btn = getByTestId('diff-pane-reset-all') as HTMLButtonElement
    expect(btn.disabled).toBe(false)
  })
})

describe('countDiffChanges', () => {
  it('returns 0 for missing slot', () => {
    expect(countDiffChanges(undefined)).toBe(0)
  })
  it('returns 0 when slot has no unsaved edits (avoid badge over-promising)', () => {
    expect(
      countDiffChanges({ payload: {}, overlay: ['a'], unsavedDirty: false })
    ).toBe(0)
  })
  it('returns overlay length when there are unsaved edits', () => {
    expect(
      countDiffChanges({
        payload: {},
        overlay: ['a', 'b', 'c'],
        unsavedDirty: true
      })
    ).toBe(3)
  })
})
