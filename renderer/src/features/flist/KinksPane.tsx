import { useCallback, useEffect, useMemo, useState } from 'react'
import { useStore } from '../../state'
import { CHOICE_LABELS, type KinkChoice } from './ChoiceButtons'
import {
  bucketByChoice,
  buildUnifiedKinks,
  readCustomsFirst,
  sortUnifiedKinks,
  type UnifiedKink
} from './kinksUnified'
import { KinkRow, parseKinkDrag } from './KinkRow'

const BUCKET_ORDER: KinkChoice[] = ['fave', 'yes', 'maybe', 'no']

// Unified Kinks tab. Replaces the old Standard kinks pane: 4 columns
// for the assignable choices (Fave/Yes/Maybe/No), flat alphabetical
// lists, customs and standards interleaved (or customs-first if the
// character's `settings.customs_first` is on). The 5th choice
// (undecided) lives in the right preview pane as a pool that the user
// drags from.
export function KinksPane({ characterId }: { characterId: string }) {
  const slot = useStore((s) => s.flistWorking[characterId])
  const mapping = useStore((s) => s.flistMapping.payload)
  const mappingStatus = useStore((s) => s.flistMapping.status)
  const loadMapping = useStore((s) => s.flistLoadMapping)
  const setStandardKink = useStore((s) => s.flistStandardKinkSet)
  const editCustom = useStore((s) => s.flistCustomKinksEdit)
  const [filter, setFilter] = useState('')

  useEffect(() => {
    if (mappingStatus === 'idle') void loadMapping()
  }, [mappingStatus, loadMapping])

  const unified = useMemo(() => buildUnifiedKinks(slot, mapping), [slot, mapping])
  const customsFirst = useMemo(() => readCustomsFirst(slot), [slot])
  const filterLower = filter.trim().toLowerCase()
  const visible = useMemo(() => {
    const assigned = unified.filter((u) => u.choice !== 'undecided')
    return filterLower
      ? assigned.filter((u) => u.name.toLowerCase().includes(filterLower))
      : assigned
  }, [unified, filterLower])
  const sorted = useMemo(
    () => sortUnifiedKinks(visible, customsFirst),
    [visible, customsFirst]
  )
  const buckets = useMemo(() => bucketByChoice(sorted), [sorted])

  const setChoice = useCallback(
    (entry: UnifiedKink, next: KinkChoice) => {
      if (entry.type === 'standard') {
        setStandardKink(characterId, entry.rawId, next)
      } else {
        editCustom(characterId, entry.rawId, 'choice', next)
      }
    },
    [characterId, setStandardKink, editCustom]
  )

  const handleDrop = useCallback(
    (e: React.DragEvent, bucket: KinkChoice) => {
      e.preventDefault()
      const drag = parseKinkDrag(e)
      if (!drag) return
      const entry = unified.find((u) => u.type === drag.type && u.rawId === drag.id)
      if (entry && entry.choice !== bucket) setChoice(entry, bucket)
    },
    [unified, setChoice]
  )

  if (!slot) {
    return <div className="kinks-pane kinks-pane-loading">Loading working copy…</div>
  }

  return (
    <div className="kinks-pane" data-testid="kinks-pane">
      <div className="kinks-pane-controls">
        <input
          type="search"
          className="kinks-pane-search"
          placeholder="Filter assigned kinks…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          data-testid="kinks-pane-search"
        />
        <span className="kinks-pane-hint">
          Drag rows between columns, or focus a row and press <kbd>F</kbd>/<kbd>Y</kbd>/<kbd>M</kbd>/<kbd>N</kbd>/<kbd>U</kbd> (or <kbd>1</kbd>–<kbd>4</kbd>/<kbd>0</kbd>).
        </span>
      </div>
      <div className="kinks-pane-columns">
        {BUCKET_ORDER.map((bucket) => (
          <KinkColumn
            key={bucket}
            bucket={bucket}
            entries={buckets[bucket]}
            setChoice={setChoice}
            onDrop={(e) => handleDrop(e, bucket)}
          />
        ))}
      </div>
    </div>
  )
}

function KinkColumn({
  bucket,
  entries,
  setChoice,
  onDrop
}: {
  bucket: KinkChoice
  entries: UnifiedKink[]
  setChoice: (entry: UnifiedKink, next: KinkChoice) => void
  onDrop: (e: React.DragEvent) => void
}) {
  const [over, setOver] = useState(false)
  return (
    <section
      className={`kink-column kink-column-${bucket}${over ? ' kink-column-over' : ''}`}
      data-testid={`kink-column-${bucket}`}
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false)
        onDrop(e)
      }}
    >
      <header className="kink-column-header">
        <span className={`kink-column-title kink-choice-${bucket}`}>
          {CHOICE_LABELS[bucket]}
        </span>
        <span className="kink-column-count">{entries.length}</span>
      </header>
      {entries.length === 0 ? (
        <div className="kink-column-empty">drop here</div>
      ) : (
        <ul className="kink-column-list">
          {entries.map((entry) => (
            <KinkRow key={entry.id} entry={entry} onChoice={setChoice} />
          ))}
        </ul>
      )}
    </section>
  )
}
