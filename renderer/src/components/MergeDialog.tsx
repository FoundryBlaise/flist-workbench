import { useMemo, useState } from 'react'
import { useStore } from '../state'
import {
  CUSTOM_KINK_ORDER,
  GALLERY_ORDER,
  fieldValue,
  splitField,
  type MergeSide
} from '../state/merge'
import type { WorkingPayload } from '../state/flist'
import {
  resolveInfotagDescriptors,
  type ResolvedInfotagModel
} from '../features/flist/infotagsResolver'
import { describeOrigin } from './describeOrigin'

/** Another writer changed the Workbench on screen while the window held
 *  unsaved edits, and some fields were changed on both sides. Everything
 *  else is merged already; this asks, for each of those fields, whose
 *  version to keep, and commits the merge once every field is answered.
 *  Nothing is saved until then. */
export function MergeDialog() {
  const characterId = useStore((s) => s.flistActiveCharacterId)
  const question = useStore((s) => (characterId ? s.flistMergeQuestion[characterId] : null))
  const mine = useStore((s) => (characterId ? s.flistWorking[characterId]?.payload : undefined))
  if (!characterId || !question || !mine) return null
  // A new question (another change came in) starts without answers.
  return <MergeQuestion key={question.at} characterId={characterId} question={question} mine={mine} />
}

type Question = NonNullable<ReturnType<typeof useStore.getState>['flistMergeQuestion'][string]>

function MergeQuestion({
  characterId,
  question,
  mine
}: {
  characterId: string
  question: Question
  mine: WorkingPayload
}) {
  const mapping = useStore((s) => s.flistMapping.payload)
  const answer = useStore((s) => s.flistAnswerMerge)
  const [chosen, setChosen] = useState<Record<string, MergeSide>>({})
  const names = useMemo(() => fieldNamer(mapping), [mapping])
  const choose = (field: string, side: MergeSide) => setChosen({ ...chosen, [field]: side })
  const complete = question.fields.every((f) => chosen[f])
  const by = describeOrigin(question.label)

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="merge-dialog-title"
      data-testid="merge-dialog"
    >
      <div className="modal merge-dialog">
        <header className="modal-head">
          <h2 className="modal-title" id="merge-dialog-title">
            {question.fields.length === 1
              ? 'One field was changed on both sides'
              : `${question.fields.length} fields were changed on both sides`}
          </h2>
        </header>
        <div className="modal-body">
          <p>
            {by ? `The Workbench was changed by ${by}` : 'The Workbench was changed outside the editor'}{' '}
            while you had unsaved edits here. Everything else is merged. For
            each field below, choose which version to keep.
          </p>
          <ul className="merge-fields">
            {question.fields.map((field) => (
              <li key={field} className="merge-field" data-testid="merge-field" data-field={field}>
                <div className="merge-field-name">{names.field(field, mine, question.theirs)}</div>
                <MergeSideRow
                  side="mine"
                  label="Keep mine"
                  value={preview(field, fieldValue(mine, field), names)}
                  pressed={chosen[field] === 'mine'}
                  onChoose={() => choose(field, 'mine')}
                />
                <MergeSideRow
                  side="theirs"
                  label="Take theirs"
                  value={preview(field, fieldValue(question.theirs, field), names)}
                  pressed={chosen[field] === 'theirs'}
                  onChoose={() => choose(field, 'theirs')}
                />
              </li>
            ))}
          </ul>
        </div>
        <footer className="modal-foot">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!complete}
            onClick={() => answer(characterId, chosen)}
            data-testid="merge-apply"
          >
            Apply
          </button>
        </footer>
      </div>
    </div>
  )
}

function MergeSideRow(props: {
  side: MergeSide
  label: string
  value: string
  pressed: boolean
  onChoose: () => void
}) {
  return (
    <div className="merge-side">
      <button
        type="button"
        className="btn btn-ghost merge-choice"
        aria-pressed={props.pressed}
        onClick={props.onChoose}
        data-testid={props.side === 'mine' ? 'merge-keep-mine' : 'merge-take-theirs'}
      >
        {props.label}
      </button>
      <span className="merge-value">{props.value}</span>
    </div>
  )
}

interface FieldNames {
  /** The field's name, as the user knows it. */
  field: (field: string, mine: WorkingPayload, theirs: WorkingPayload) => string
  /** A list field's value by its item's label. */
  listItem: (field: string, value: string) => string
}

/** User-facing names of merge fields (state/merge.ts), with the mapping
 *  list for profile fields and kinks when the window has it. */
function fieldNamer(mapping: Record<string, unknown> | null): FieldNames {
  const resolver: ResolvedInfotagModel | null = mapping ? resolveInfotagDescriptors(mapping) : null
  const kinkNames = new Map<string, string>()
  if (Array.isArray(mapping?.kinks)) {
    for (const entry of mapping.kinks as unknown[]) {
      const e = entry as { id?: unknown; name?: unknown }
      if (e && e.id != null && typeof e.name === 'string') kinkNames.set(String(e.id), e.name)
    }
  }
  const nameOf = (field: string, mine: WorkingPayload, theirs: WorkingPayload): string => {
    if (field === GALLERY_ORDER) return 'Order of the gallery'
    if (field === CUSTOM_KINK_ORDER) return 'Order of the custom kinks'
    const { top, id: member } = splitField(field)
    const id = member ?? field
    switch (top) {
      case 'character':
        if (id === 'description') return 'Description'
        if (id === 'custom_title') return 'Custom title'
        if (id === 'name') return 'Name'
        return id
      case 'infotags':
        return resolver?.byId.get(id)?.label ?? `Profile field ${id}`
      case 'kinks':
        return `Kink: ${kinkNames.get(id) ?? id}`
      case 'custom_kinks': {
        const kink = (fieldValue(mine, field) ?? fieldValue(theirs, field)) as
          | { name?: unknown }
          | undefined
        return typeof kink?.name === 'string' && kink.name
          ? `Custom kink: ${kink.name}`
          : `Custom kink ${id}`
      }
      case 'images':
        return id.startsWith('local-') ? `Local image ${id.slice(6)}` : `Image ${id}`
      case 'settings':
        return 'Profile settings'
      default:
        return field
    }
  }
  const listItem = (field: string, value: string): string => {
    const { top, id } = splitField(field)
    if (top !== 'infotags' || id === null) return value
    const item = resolver?.byId.get(id)?.listItems?.find((i) => i.value === value)
    return item?.label ?? value
  }
  return { field: nameOf, listItem }
}

const PREVIEW_CHARS = 160

/** One side's value, short enough for a row. */
function preview(field: string, value: unknown, names: FieldNames): string {
  if (value === undefined || value === null) {
    return splitField(field).top === 'images' ? 'Not on the profile' : 'Not set'
  }
  if (typeof value === 'string') {
    if (value === '') return 'Empty'
    const text = names.listItem(field, value)
    return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.join(', ')
  const v = value as { name?: unknown; description?: unknown; choice?: unknown; _deleted?: unknown }
  if (splitField(field).top === 'images') {
    return typeof v.description === 'string' && v.description
      ? `On the profile, captioned “${v.description}”`
      : 'On the profile, no caption'
  }
  if (v._deleted) return 'Deleted'
  const parts = [v.name, v.choice, v.description].filter(
    (p): p is string => typeof p === 'string' && p !== ''
  )
  return parts.length > 0 ? preview(field, parts.join(' · '), names) : 'Changed'
}
