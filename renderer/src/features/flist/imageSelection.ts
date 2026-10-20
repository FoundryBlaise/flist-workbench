// Multi-select for the Images tab's pool and trash.
//
// The selection keeps the order things were picked in, because "Add to
// gallery" appends in that order: picking 3, then 1, then 2 is how a
// user says what order they want them on the profile. A Shift-range
// adds what it covers in the order the list shows it.

export type Selection = {
  ids: string[]
  /** Where the next Shift-click range starts. */
  anchor: string | null
}

export const EMPTY_SELECTION: Selection = { ids: [], anchor: null }

/** Ctrl-click or a checkbox: add or remove one, and move the anchor. */
export function toggleSelected(sel: Selection, id: string): Selection {
  const has = sel.ids.includes(id)
  return {
    ids: has ? sel.ids.filter((x) => x !== id) : [...sel.ids, id],
    anchor: id
  }
}

/** Shift-click: everything between the anchor and `id`, as the list
 *  shows it, joins the selection. Without an anchor it selects `id`. */
export function selectRange(sel: Selection, id: string, visible: string[]): Selection {
  const to = visible.indexOf(id)
  if (to < 0) return sel
  const from = sel.anchor ? visible.indexOf(sel.anchor) : -1
  if (from < 0) return toggleSelected(sel, id)
  const [lo, hi] = from <= to ? [from, to] : [to, from]
  const have = new Set(sel.ids)
  const added = visible.slice(lo, hi + 1).filter((x) => !have.has(x))
  return { ids: [...sel.ids, ...added], anchor: sel.anchor }
}

export function selectAll(visible: string[]): Selection {
  return { ids: visible.slice(), anchor: visible[0] ?? null }
}

/** Drop what the list no longer shows — a filter changed, or the files
 *  moved — so an action never touches something the user can't see. */
export function pruneSelection(sel: Selection, visible: string[]): Selection {
  const shown = new Set(visible)
  const ids = sel.ids.filter((x) => shown.has(x))
  const anchor = sel.anchor && shown.has(sel.anchor) ? sel.anchor : null
  if (ids.length === sel.ids.length && anchor === sel.anchor) return sel
  return { ids, anchor }
}
