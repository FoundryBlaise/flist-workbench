// Shared row used by both the Kinks bucket columns and the Undecided
// pool. Carries drag-source wiring, the hotkey map, and a small ★ pip
// to mark custom kinks visually.

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

interface KinkRowProps {
  entry: UnifiedKink
  onChoice: (entry: UnifiedKink, next: KinkChoice) => void
}

export function KinkRow({ entry, onChoice }: KinkRowProps) {
  return (
    <li
      className={`kink-row kink-row-${entry.type} kink-row-${entry.choice}`}
      draggable
      title={entry.description || undefined}
      tabIndex={0}
      data-kink-id={entry.id}
      data-kink-type={entry.type}
      onDragStart={(e) => {
        e.dataTransfer.setData(
          KINK_DRAG_MIME,
          JSON.stringify({ type: entry.type, id: entry.rawId })
        )
        e.dataTransfer.effectAllowed = 'move'
      }}
      onKeyDown={(e) => {
        const next = HOTKEY_TO_CHOICE[e.key]
        if (!next) return
        e.preventDefault()
        onChoice(entry, next)
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

/** Parses the drag payload set by KinkRow.onDragStart. Returns null on
 *  an unrecognised payload so callers can ignore stray drops. */
export function parseKinkDrag(
  e: React.DragEvent
): { type: 'standard' | 'custom'; id: string } | null {
  const raw = e.dataTransfer.getData(KINK_DRAG_MIME)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { type?: unknown; id?: unknown }
    if (
      (parsed.type === 'standard' || parsed.type === 'custom') &&
      typeof parsed.id === 'string'
    ) {
      return { type: parsed.type, id: parsed.id }
    }
  } catch {
    // ignore malformed payloads
  }
  return null
}
