// Tier 7 Step 7 — undo / redo stack mechanics.
//
// Wiring of flistRecordPatch into the existing mutators (description
// edits, kink choice flips, bulk ops, etc.) is Step 13; this file only
// covers the stack apply layer and cap semantics in isolation.

import { beforeEach, describe, expect, it } from 'vitest'
import { useStore } from '../../state'
import { emptyWorkingSlot, type UndoPatch } from '../flist'

function seedActiveSet(
  characterId: string,
  setId: string,
  description: string
) {
  const slot = {
    ...emptyWorkingSlot(),
    payload: { _overlay: [], character: { description } }
  }
  useStore.setState({
    flistActiveSetId: { [characterId]: setId },
    flistSetWorking: { [setId]: slot },
    flistSetUndoStack: { [setId]: [] },
    flistSetRedoStack: { [setId]: [] },
    flistWorking: {}
  })
}

beforeEach(() => {
  useStore.setState({
    flistSets: {},
    flistActiveSetId: {},
    flistSetWorking: {},
    flistSetUndoStack: {},
    flistSetRedoStack: {},
    flistWorking: {}
  })
})

describe('redo clears on new push', () => {
  it('pushing a patch after an undo drops everything on redo', () => {
    seedActiveSet('7', 'set-A', 'after')
    useStore.setState({
      flistSetUndoStack: {
        'set-A': [
          {
            kind: 'set',
            path: 'character.description',
            before: 'before',
            after: 'after'
          }
        ]
      }
    })
    useStore.getState().flistUndo('7')
    expect(useStore.getState().flistSetRedoStack['set-A']).toHaveLength(1)

    // A fresh user edit clears the redo stack so a forward branch can't
    // resurrect intermediate states the user has since diverged from.
    useStore.getState().flistRecordPatch('set-A', {
      kind: 'set',
      path: 'character.description',
      before: 'before',
      after: 'fresh-edit'
    })
    expect(useStore.getState().flistSetRedoStack['set-A']).toEqual([])
    expect(useStore.getState().flistSetUndoStack['set-A']).toHaveLength(1)
  })
})

describe('replace-overlay patches', () => {
  it('revert restores the snapshotted payload + overlay verbatim', () => {
    const before = {
      _overlay: ['custom_kinks.local:a.name'],
      custom_kinks: { 'local:a': { name: 'before', choice: 'fave' } }
    }
    const after = {
      _overlay: [],
      custom_kinks: { 'local:b': { name: 'after', choice: 'yes' } }
    }
    const slotAfter = { ...emptyWorkingSlot(), payload: after, overlay: [] }
    useStore.setState({
      flistActiveSetId: { '7': 'set-A' },
      flistSetWorking: { 'set-A': slotAfter },
      flistSetUndoStack: {
        'set-A': [
          {
            kind: 'replace-overlay',
            beforePayload: before,
            beforeOverlay: ['custom_kinks.local:a.name'],
            afterPayload: after,
            afterOverlay: []
          } satisfies UndoPatch
        ]
      },
      flistSetRedoStack: { 'set-A': [] }
    })
    useStore.getState().flistUndo('7')
    const reverted = useStore.getState().flistSetWorking['set-A']
    expect(reverted.overlay).toEqual(['custom_kinks.local:a.name'])
    expect(
      (reverted.payload as { custom_kinks: Record<string, unknown> })
        .custom_kinks['local:a']
    ).toBeDefined()
  })
})

describe('per-set isolation', () => {
  it('switching active set does not clear the prior set stack', () => {
    seedActiveSet('7', 'set-A', 'x')
    useStore.getState().flistRecordPatch('set-A', {
      kind: 'set',
      path: 'character.description',
      before: '',
      after: 'x'
    })
    useStore.setState({
      flistActiveSetId: { '7': 'set-B' },
      flistSetWorking: { 'set-B': emptyWorkingSlot() }
    })
    // Stack for set-A survives the switch — Tier 7 keeps each set's
    // undo history in memory across set/character switches.
    expect(useStore.getState().flistSetUndoStack['set-A']).toHaveLength(1)
  })
})

describe('cap = 50, oldest drops on overflow', () => {
  it('51st push truncates head, preserves order', () => {
    seedActiveSet('7', 'set-A', 'seed')
    for (let i = 0; i < 51; i++) {
      useStore.getState().flistRecordPatch('set-A', {
        kind: 'set',
        path: 'character.description',
        before: String(i - 1),
        after: String(i)
      })
    }
    const stack = useStore.getState().flistSetUndoStack['set-A']
    expect(stack).toHaveLength(50)
    // Patch with `after: '0'` was the original head — it should now be
    // gone, replaced by `after: '1'` at index 0.
    expect((stack[0] as { after: string }).after).toBe('1')
    expect((stack[49] as { after: string }).after).toBe('50')
  })
})
