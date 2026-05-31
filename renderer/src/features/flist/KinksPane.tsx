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
import { useKinkSelection } from './useKinkSelection'

const BUCKET_ORDER: KinkChoice[] = ['fave', 'yes', 'maybe', 'no']

// Unified Kinks tab. 4 columns for the assignable choices, flat
// alphabetical lists with customs and standards interleaved (or
// customs-first when `settings.customs_first` is set). Click a row to
// focus, Shift/Ctrl-click for multi-select. Drag any row to move it
// — if it's selected, the drag carries every selected row at once.
// Hotkeys F/Y/M/N/U and 1/2/3/4/0 apply to the focused row's
// selection (or just the focused row when not selected).
export function KinksPane({ characterId }: { characterId: string }) {
  const slot = useStore((s) => s.flistWorking[characterId])
  const liveArchive = useStore(
    (s) => s.flistArchive[characterId]?.live ?? null
  )
  const readOnly = useStore((s) => s.editorReadOnly)
  const mapping = useStore((s) => s.flistMapping.payload)
  const mappingStatus = useStore((s) => s.flistMapping.status)
  const loadMapping = useStore((s) => s.flistLoadMapping)
  const setStandardKink = useStore((s) => s.flistStandardKinkSet)
  const editCustom = useStore((s) => s.flistCustomKinksEdit)
  const [filter, setFilter] = useState('')
  const selection = useKinkSelection()

  useEffect(() => {
    if (mappingStatus === 'idle') void loadMapping()
  }, [mappingStatus, loadMapping])

  // In read-only views (From F-list / Backup) drive the bucket
  // columns from the live archive so the user sees what's actually
  // on F-list, not their staged edits.
  const sourceSlot = useMemo(
    () =>
      readOnly && liveArchive
        ? { payload: liveArchive as Record<string, unknown> }
        : slot,
    [readOnly, liveArchive, slot]
  )
  const unified = useMemo(
    () => buildUnifiedKinks(sourceSlot, mapping),
    [sourceSlot, mapping]
  )
  const customsFirst = useMemo(() => readCustomsFirst(sourceSlot), [sourceSlot])
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
  const byCompositeId = useMemo(() => {
    const map = new Map<string, UnifiedKink>()
    for (const u of unified) map.set(u.id, u)
    return map
  }, [unified])

  const setChoice = useCallback(
    (entries: UnifiedKink[], next: KinkChoice) => {
      for (const entry of entries) {
        if (entry.choice === next) continue
        if (entry.type === 'standard') {
          setStandardKink(characterId, entry.rawId, next)
        } else {
          editCustom(characterId, entry.rawId, 'choice', next)
        }
      }
    },
    [characterId, setStandardKink, editCustom]
  )

  const handleDrop = useCallback(
    (e: React.DragEvent, bucket: KinkChoice) => {
      e.preventDefault()
      const payload = parseKinkDrag(e)
      if (payload.length === 0) return
      const entries: UnifiedKink[] = []
      for (const item of payload) {
        const entry = unified.find(
          (u) => u.type === item.type && u.rawId === item.id
        )
        if (entry && entry.choice !== bucket) entries.push(entry)
      }
      if (entries.length > 0) setChoice(entries, bucket)
      selection.clear()
    },
    [unified, setChoice, selection]
  )

  const selectionForDrag = useMemo(() => {
    if (selection.selected.size === 0) return []
    const out: UnifiedKink[] = []
    for (const id of selection.selected) {
      const entry = byCompositeId.get(id)
      if (entry) out.push(entry)
    }
    return out
  }, [selection.selected, byCompositeId])

  if (!sourceSlot) {
    return <div className="kinks-pane kinks-pane-loading">Loading…</div>
  }

  return (
    <div className="kinks-pane" data-testid="kinks-pane">
      <div className="kinks-pane-controls">
        <input
          type="search"
          className="kinks-pane-search"
          placeholder={readOnly ? 'Filter live kinks…' : 'Filter assigned kinks…'}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          data-testid="kinks-pane-search"
        />
        <span className="kinks-pane-hint">
          {readOnly ? (
            <>Read-only — switch to <b>My edits</b> to assign or change.</>
          ) : (
            <>
              Drag, or focus a row + <kbd>F</kbd>/<kbd>Y</kbd>/<kbd>M</kbd>/<kbd>N</kbd>/<kbd>U</kbd>
              {' '}(or <kbd>1</kbd>–<kbd>4</kbd>/<kbd>0</kbd>). Shift/Ctrl-click for multi-select.
            </>
          )}
        </span>
      </div>
      <div className="kinks-pane-columns">
        {BUCKET_ORDER.map((bucket) => (
          <KinkColumn
            key={bucket}
            bucket={bucket}
            entries={buckets[bucket]}
            selection={selection}
            selectionForDrag={selectionForDrag}
            readOnly={readOnly}
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
  selection,
  selectionForDrag,
  readOnly,
  setChoice,
  onDrop
}: {
  bucket: KinkChoice
  entries: UnifiedKink[]
  selection: ReturnType<typeof useKinkSelection>
  selectionForDrag: UnifiedKink[]
  readOnly: boolean
  setChoice: (entries: UnifiedKink[], next: KinkChoice) => void
  onDrop: (e: React.DragEvent) => void
}) {
  const [over, setOver] = useState(false)
  const orderedIds = entries.map((e) => e.id)
  return (
    <section
      className={`kink-column kink-column-${bucket}${over ? ' kink-column-over' : ''}`}
      data-testid={`kink-column-${bucket}`}
      onDragOver={
        readOnly
          ? undefined
          : (e) => {
              e.preventDefault()
              setOver(true)
            }
      }
      onDragLeave={readOnly ? undefined : () => setOver(false)}
      onDrop={
        readOnly
          ? undefined
          : (e) => {
              setOver(false)
              onDrop(e)
            }
      }
    >
      <header className="kink-column-header">
        <span className={`kink-column-title kink-choice-${bucket}`}>
          {CHOICE_LABELS[bucket]}
        </span>
        <span className="kink-column-count">{entries.length}</span>
      </header>
      {entries.length === 0 ? (
        <div className="kink-column-empty">{readOnly ? '—' : 'drop here'}</div>
      ) : (
        <ul className="kink-column-list">
          {entries.map((entry) => (
            <KinkRow
              key={entry.id}
              entry={entry}
              selected={selection.isSelected(entry.id)}
              selectionForDrag={selectionForDrag}
              readOnly={readOnly}
              onChoice={setChoice}
              onClick={(e, ev) =>
                selection.handleRowClick(e.id, orderedIds, ev)
              }
            />
          ))}
        </ul>
      )}
    </section>
  )
}
