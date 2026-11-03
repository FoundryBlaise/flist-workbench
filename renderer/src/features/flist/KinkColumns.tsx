// The four kink columns (Fave / Yes / Maybe / No). The editor's Kinks
// tab draws them with drag, drop, hotkeys and selection; the Foreign
// view draws the same columns with none of that, so both read alike and
// change together.

import { useState } from 'react'
import { CHOICE_LABELS, type KinkChoice } from './ChoiceButtons'
import { KINK_BUCKET_ORDER, type Buckets, type UnifiedKink } from './kinksUnified'
import { KinkRow } from './KinkRow'
import type { KinkSelectionAPI } from './useKinkSelection'

/** What the editor wires into the columns so rows can be moved. */
export interface KinkColumnsInteraction {
  selection: KinkSelectionAPI
  selectionForDrag: UnifiedKink[]
  setChoice: (entries: UnifiedKink[], next: KinkChoice) => void
  onDrop: (e: React.DragEvent, bucket: KinkChoice) => void
}

const NO_SELECTION: UnifiedKink[] = []
const noop = () => {}

export function KinkColumns({
  buckets,
  readOnly,
  interaction,
  testIdPrefix = 'kink-column'
}: {
  buckets: Buckets
  readOnly: boolean
  /** Absent in views that never change a kink. */
  interaction?: KinkColumnsInteraction
  testIdPrefix?: string
}) {
  return (
    <div className="kinks-pane-columns">
      {KINK_BUCKET_ORDER.map((bucket) => (
        <KinkColumn
          key={bucket}
          bucket={bucket}
          entries={buckets[bucket]}
          readOnly={readOnly || !interaction}
          interaction={interaction}
          testId={`${testIdPrefix}-${bucket}`}
        />
      ))}
    </div>
  )
}

function KinkColumn({
  bucket,
  entries,
  readOnly,
  interaction,
  testId
}: {
  bucket: KinkChoice
  entries: UnifiedKink[]
  readOnly: boolean
  interaction?: KinkColumnsInteraction
  testId: string
}) {
  const [over, setOver] = useState(false)
  const orderedIds = entries.map((e) => e.id)
  const droppable = !readOnly && interaction
  return (
    <section
      className={`kink-column kink-column-${bucket}${over ? ' kink-column-over' : ''}`}
      data-testid={testId}
      onDragOver={
        droppable
          ? (e) => {
              e.preventDefault()
              setOver(true)
            }
          : undefined
      }
      onDragLeave={droppable ? () => setOver(false) : undefined}
      onDrop={
        droppable
          ? (e) => {
              setOver(false)
              interaction.onDrop(e, bucket)
            }
          : undefined
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
              selected={interaction?.selection.isSelected(entry.id) ?? false}
              selectionForDrag={interaction?.selectionForDrag ?? NO_SELECTION}
              readOnly={readOnly}
              onChoice={interaction?.setChoice ?? noop}
              onClick={(e, ev) =>
                interaction?.selection.handleRowClick(e.id, orderedIds, ev)
              }
            />
          ))}
        </ul>
      )}
    </section>
  )
}
