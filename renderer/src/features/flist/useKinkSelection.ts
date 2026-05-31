import { useCallback, useRef, useState } from 'react'

// Per-surface selection. KinksPane (the 4-column bucket view) and
// KinksUndecidedPool's standard-kinks section each own one instance.
// Selection lives in component state, not the store — the dataTransfer
// payload moves it across panes when needed (a drag carries every
// selected id, the receiving pane doesn't need to know what was
// selected before the drop).

export interface KinkSelectionAPI {
  /** Composite ids in the current selection (the `id` field on
   *  UnifiedKink — `std:<id>` or `cst:<id>`). */
  selected: Set<string>
  isSelected: (id: string) => boolean
  /** Handle a click on a row. The `orderedIds` list is the visible row
   *  order in this surface, used for Shift-range expansion. */
  handleRowClick: (id: string, orderedIds: string[], e: React.MouseEvent) => void
  clear: () => void
}

export function useKinkSelection(): KinkSelectionAPI {
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  // Anchor for Shift-range — the last id the user single-clicked or
  // Ctrl-clicked. Shift+click extends from anchor to the new target.
  const anchorRef = useRef<string | null>(null)

  const isSelected = useCallback((id: string) => selected.has(id), [selected])

  const handleRowClick = useCallback(
    (id: string, orderedIds: string[], e: React.MouseEvent) => {
      const ctrl = e.ctrlKey || e.metaKey
      const shift = e.shiftKey
      if (shift && anchorRef.current && orderedIds.includes(anchorRef.current)) {
        const a = orderedIds.indexOf(anchorRef.current)
        const b = orderedIds.indexOf(id)
        const [lo, hi] = a <= b ? [a, b] : [b, a]
        const next = new Set<string>()
        for (let i = lo; i <= hi; i++) next.add(orderedIds[i])
        setSelected(next)
        // Don't move the anchor on a Shift extend — that's the standard
        // Win/macOS behaviour and the only one that lets the user
        // shrink a range with another Shift+click.
        return
      }
      if (ctrl) {
        const next = new Set(selected)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        setSelected(next)
        anchorRef.current = id
        return
      }
      // Plain click → single-select.
      setSelected(new Set([id]))
      anchorRef.current = id
    },
    [selected]
  )

  const clear = useCallback(() => {
    setSelected(new Set())
    anchorRef.current = null
  }, [])

  return { selected, isSelected, handleRowClick, clear }
}
