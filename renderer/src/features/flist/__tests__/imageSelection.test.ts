import { describe, expect, it } from 'vitest'
import {
  EMPTY_SELECTION,
  pruneSelection,
  selectAll,
  selectRange,
  toggleSelected
} from '../imageSelection'

const LIST = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']

describe('image selection', () => {
  it('keeps the order things were picked in', () => {
    let sel = toggleSelected(EMPTY_SELECTION, 'c')
    sel = toggleSelected(sel, 'a')
    sel = toggleSelected(sel, 'b')
    expect(sel.ids).toEqual(['c', 'a', 'b'])
  })

  it('a second toggle takes one out again', () => {
    const sel = toggleSelected(toggleSelected(EMPTY_SELECTION, 'a'), 'a')
    expect(sel.ids).toEqual([])
    expect(sel.anchor).toBe('a')
  })

  it('shift-click selects all ten between the anchor and the click', () => {
    const sel = selectRange(toggleSelected(EMPTY_SELECTION, 'a'), 'j', LIST)
    expect(sel.ids).toEqual(LIST)
  })

  it('a range upwards adds in list order and keeps the anchor', () => {
    const start = toggleSelected(EMPTY_SELECTION, 'e')
    const sel = selectRange(start, 'b', LIST)
    expect(sel.ids).toEqual(['e', 'b', 'c', 'd'])
    expect(sel.anchor).toBe('e')
  })

  it('a range never duplicates what is already picked', () => {
    let sel = toggleSelected(EMPTY_SELECTION, 'c')
    sel = toggleSelected(sel, 'a')
    sel = selectRange(sel, 'e', LIST)
    expect(sel.ids).toEqual(['c', 'a', 'b', 'd', 'e'])
  })

  it('shift-click with nothing picked yet selects just that one', () => {
    expect(selectRange(EMPTY_SELECTION, 'd', LIST).ids).toEqual(['d'])
  })

  it('select all takes what the list shows', () => {
    expect(selectAll(['x', 'y']).ids).toEqual(['x', 'y'])
  })

  it('pruning drops what is no longer shown, and is a no-op otherwise', () => {
    const sel = { ids: ['a', 'c', 'e'], anchor: 'c' }
    expect(pruneSelection(sel, ['a', 'e'])).toEqual({ ids: ['a', 'e'], anchor: null })
    expect(pruneSelection(sel, LIST)).toBe(sel)
  })
})
