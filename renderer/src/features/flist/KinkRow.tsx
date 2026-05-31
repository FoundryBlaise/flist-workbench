// Shared row used by the Kinks bucket columns and the Undecided pool's
// standard section. Handles drag-source wiring (single + multi), the
// keyboard hotkey map, click-to-select (with Shift/Ctrl modifiers), and
// a ★ pip marking customs.

import type { KinkChoice } from './ChoiceButtons'
import type { UnifiedKink } from './kinksUnified'

export const KINK_DRAG_MIME = 'application/x-kink-id'

export const HOTKEY_TO_CHOICE: Record<string, KinkChoice> = {
  f: 'fave', F: 'fave',
  y: 'yes', Y: 'yes',
  m: 'maybe', M: 'maybe',
  n: 'no', N: 'no',
  u: 'undecided', U: 'undecided',
  '1': 'fave',
  '2': 'yes',
  '3': 'maybe',
  '4': 'no',
  '0': 'undecided'
}

export type KinkDragPayload = Array<{ type: 'standard' | 'custom'; id: string }>

interface KinkRowProps {
  entry: UnifiedKink
  selected: boolean
  selectionForDrag: UnifiedKink[]
  readOnly?: boolean
  onChoice: (entries: UnifiedKink[], next: KinkChoice) => void
  onClick: (entry: UnifiedKink, e: React.MouseEvent) => void
}

export function KinkRow({
  entry,
  selected,
  selectionForDrag,
  readOnly,
  onChoice,
  onClick
}: KinkRowProps) {
  return (
    <li
      className={`kink-row kink-row-${entry.type} kink-row-${entry.choice}${
        selected ? ' kink-row-selected' : ''
      }${readOnly ? ' kink-row-readonly' : ''}`}
      draggable={!readOnly}
      title={entry.description || undefined}
      tabIndex={readOnly ? -1 : 0}
      data-kink-id={entry.id}
      data-kink-type={entry.type}
      onClick={(e) => {
        if (readOnly) return
        onClick(entry, e)
      }}
      onDragStart={(e) => {
        if (readOnly) {
          e.preventDefault()
          return
        }
        const payload: KinkDragPayload = selected
          ? selectionForDrag.map((u) => ({ type: u.type, id: u.rawId }))
          : [{ type: entry.type, id: entry.rawId }]
        e.dataTransfer.setData(KINK_DRAG_MIME, JSON.stringify(payload))
        e.dataTransfer.effectAllowed = 'move'
      }}
      onKeyDown={(e) => {
        if (readOnly) return
        const next = HOTKEY_TO_CHOICE[e.key]
        if (!next) return
        e.preventDefault()
        onChoice(selected ? selectionForDrag : [entry], next)
      }}
    >
      {entry.type === 'custom' && (
        <span className="kink-row-pip" aria-label="Custom kink" title="Custom kink">
          ★
        </span>
      )}
      <span className="kink-row-name">{entry.name}</span>
    </li>
  )
}

/** Parses the drag payload set by KinkRow.onDragStart. Returns an
 *  empty array on an unrecognised payload so callers can ignore stray
 *  drops without branching. */
export function parseKinkDrag(e: React.DragEvent): KinkDragPayload {
  const raw = e.dataTransfer.getData(KINK_DRAG_MIME)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const out: KinkDragPayload = []
    for (const item of parsed) {
      if (
        item &&
        typeof item === 'object' &&
        (item.type === 'standard' || item.type === 'custom') &&
        typeof item.id === 'string'
      ) {
        out.push({ type: item.type, id: item.id })
      }
    }
    return out
  } catch {
    return []
  }
}
