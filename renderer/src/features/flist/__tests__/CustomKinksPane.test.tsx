// Tier 3 QA Missing test #4: KinkListRail must render the union of
// `_custom_kinks_order` + in-dict-not-in-order ids (Case C reconciliation
// per Tier 3 plan §R-4). Without it, a Live re-pull that introduces a
// new kink wouldn't surface in the rail until the user happened to edit
// the row that doesn't exist on screen yet.

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { useStore } from '../../../state'
import { KinkListRail } from '../KinkListRail'

beforeEach(() => {
  useStore.setState({
    flistWorking: {},
    flistCustomKinksUI: {},
    flistMapping: {
      status: 'ready',
      payload: {
        kinks: [],
        kink_groups: [],
        infotags: [],
        listitems: [],
        _etag: null,
        _fetched_at: null
      },
      etag: null,
      fetchedAt: null,
      error: null
    }
  })
})

afterEach(() => {
  cleanup()
})

function seedSlot(payload: Record<string, unknown>) {
  useStore.setState({
    flistWorking: {
      '99': {
        payload: { _schema_version: 2, _overlay: [], ...payload },
        overlay: [],
        etag: null,
        unsavedDirty: false,
        saveStatus: 'idle',
        saveError: null,
        lastSavedAt: null,
        materialised: true
      }
    },
    flistCustomKinksUI: {
      '99': {
        selectedKinkId: null,
        selectedKinkIds: [],
        showDeleted: false,
        sort: 'insertion',
        filter: ''
      }
    }
  })
}

describe('KinkListRail Case-C reconciliation', () => {
  it('renders kinks present in the dict even when missing from _custom_kinks_order', () => {
    seedSlot({
      custom_kinks: {
        '111': { name: 'In order', choice: 'fave', children: [] },
        '222': { name: 'Live-only (not in order)', choice: 'yes', children: [] }
      },
      _custom_kinks_order: ['111']
    })
    const { queryByText } = render(<KinkListRail characterId="99" />)
    expect(queryByText('In order')).toBeTruthy()
    expect(queryByText('Live-only (not in order)')).toBeTruthy()
  })

  it('hides tombstoned rows when showDeleted is off, surfaces them otherwise', () => {
    seedSlot({
      custom_kinks: {
        '111': { name: 'Alive', choice: 'fave', children: [] },
        '222': { name: 'Tomb', choice: 'no', children: [], _deleted: true }
      },
      _custom_kinks_order: ['111', '222']
    })
    const { queryByText, rerender } = render(<KinkListRail characterId="99" />)
    expect(queryByText('Alive')).toBeTruthy()
    expect(queryByText('Tomb')).toBeNull()
    useStore.getState().flistCustomKinksSetUI('99', { showDeleted: true })
    rerender(<KinkListRail characterId="99" />)
    expect(queryByText('Tomb')).toBeTruthy()
  })
})
