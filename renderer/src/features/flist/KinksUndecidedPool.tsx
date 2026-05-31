import { useCallback, useMemo, useState } from 'react'
import { useStore } from '../../state'
import type { KinkChoice } from './ChoiceButtons'
import {
  buildUnifiedKinks,
  readCustomsFirst,
  sortUnifiedKinks,
  type UnifiedKink
} from './kinksUnified'
import { KinkRow, parseKinkDrag } from './KinkRow'

// Right-pane companion to KinksPane. Holds every kink with
// `choice === 'undecided'` — customs and standards both — and lets
// the user drag from here into one of the 4 bucket columns (or drag a
// bucket entry back into the pool to un-assign). The "+ New custom
// kink" button creates an empty custom; editing its name/description
// happens in the Custom kinks tab for now.
export function KinksUndecidedPool() {
  const flistActiveId = useStore((s) => s.flistActiveCharacterId)
  const slot = useStore((s) =>
    flistActiveId ? s.flistWorking[flistActiveId] : undefined
  )
  const mapping = useStore((s) => s.flistMapping.payload)
  const setStandardKink = useStore((s) => s.flistStandardKinkSet)
  const editCustom = useStore((s) => s.flistCustomKinksEdit)
  const addCustom = useStore((s) => s.flistCustomKinksAdd)
  const [filter, setFilter] = useState('')
  const [over, setOver] = useState(false)

  const unified = useMemo(() => buildUnifiedKinks(slot, mapping), [slot, mapping])
  const customsFirst = useMemo(() => readCustomsFirst(slot), [slot])
  const filterLower = filter.trim().toLowerCase()
  const undecided = useMemo(
    () => unified.filter((u) => u.choice === 'undecided'),
    [unified]
  )
  const filtered = useMemo(
    () =>
      filterLower
        ? undecided.filter((u) => u.name.toLowerCase().includes(filterLower))
        : undecided,
    [undecided, filterLower]
  )
  const sorted = useMemo(
    () => sortUnifiedKinks(filtered, customsFirst),
    [filtered, customsFirst]
  )

  const setChoice = useCallback(
    (entry: UnifiedKink, next: KinkChoice) => {
      if (!flistActiveId) return
      if (entry.type === 'standard') {
        setStandardKink(flistActiveId, entry.rawId, next)
      } else {
        editCustom(flistActiveId, entry.rawId, 'choice', next)
      }
    },
    [flistActiveId, setStandardKink, editCustom]
  )

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setOver(false)
      const drag = parseKinkDrag(e)
      if (!drag) return
      const entry = unified.find(
        (u) => u.type === drag.type && u.rawId === drag.id
      )
      if (entry && entry.choice !== 'undecided') setChoice(entry, 'undecided')
    },
    [unified, setChoice]
  )

  if (!flistActiveId || !slot) {
    return (
      <div className="kinks-pool kinks-pool-empty">
        <p>No working copy active.</p>
      </div>
    )
  }

  return (
    <div
      className={`kinks-pool${over ? ' kinks-pool-over' : ''}`}
      data-testid="kinks-pool"
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={handleDrop}
    >
      <header className="kinks-pool-header">
        <span className="kinks-pool-title">Undecided</span>
        <span className="kinks-pool-count">{sorted.length}</span>
        <button
          type="button"
          className="kinks-pool-add"
          onClick={() => addCustom(flistActiveId)}
          title="Add a new custom kink. Edit name + description in the Custom kinks tab."
          data-testid="kinks-pool-add"
        >
          + New custom kink
        </button>
      </header>
      <div className="kinks-pool-controls">
        <input
          type="search"
          className="kinks-pool-search"
          placeholder="Filter undecided…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          data-testid="kinks-pool-search"
        />
      </div>
      {sorted.length === 0 ? (
        <div className="kinks-pool-empty-list">
          {filterLower
            ? 'No undecided kinks match that filter.'
            : 'Every kink is assigned. Drag one back here to mark it undecided.'}
        </div>
      ) : (
        <ul className="kinks-pool-list">
          {sorted.map((entry) => (
            <KinkRow key={entry.id} entry={entry} onChoice={setChoice} />
          ))}
        </ul>
      )}
    </div>
  )
}
