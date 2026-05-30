import { useEffect } from 'react'
import { useStore } from '../../state'
import { CHOICE_LABELS, CHOICE_ORDER, type KinkChoice } from './ChoiceButtons'

export function BulkActionBar({
  characterId,
  surface
}: {
  characterId: string
  /** Which surface owns this bar — drives the action set. */
  surface: 'custom' | 'standard'
}) {
  const ui = useStore((s) => s.flistCustomKinksUI[characterId])
  const selected = ui?.selectedKinkIds ?? []
  const bulkChoiceCustom = useStore((s) => s.flistCustomKinksBulkSetChoice)
  const bulkTombstone = useStore((s) => s.flistCustomKinksBulkTombstone)
  const bulkChoiceStandard = useStore((s) => s.flistStandardKinksBulkSetChoice)
  const clearMulti = useStore((s) => s.flistCustomKinksClearMulti)
  useEffect(() => {
    if (selected.length === 0) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        clearMulti(characterId)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected.length, characterId, clearMulti])
  if (selected.length === 0) return null
  const applyChoice = (choice: KinkChoice) => {
    if (surface === 'custom') bulkChoiceCustom(characterId, selected, choice)
    else bulkChoiceStandard(characterId, selected, choice)
    clearMulti(characterId)
  }
  return (
    <div
      className="bulk-action-bar"
      role="region"
      aria-label={`Bulk actions for ${selected.length} kink${selected.length === 1 ? '' : 's'}`}
      data-testid="bulk-action-bar"
    >
      <span className="bulk-action-bar-count">
        {selected.length} selected
      </span>
      <div className="bulk-action-bar-choices">
        {CHOICE_ORDER.map((c) => (
          <button
            key={c}
            type="button"
            className={`bulk-action-bar-choice kink-choice-${c}`}
            onClick={() => applyChoice(c)}
            data-testid={`bulk-action-${c}`}
          >
            {CHOICE_LABELS[c]}
          </button>
        ))}
      </div>
      {surface === 'custom' && (
        <button
          type="button"
          className="bulk-action-bar-delete"
          onClick={() => {
            bulkTombstone(characterId, selected)
          }}
        >
          Delete
        </button>
      )}
      <button
        type="button"
        className="bulk-action-bar-cancel"
        onClick={() => clearMulti(characterId)}
        title="Clear selection (Esc)"
      >
        Clear (Esc)
      </button>
    </div>
  )
}
