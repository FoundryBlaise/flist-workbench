import { useCallback, useEffect, useMemo, useState } from 'react'
import { useStore, selectWorkingSlot } from '../../state'
import { CHOICE_LABELS, type KinkChoice } from './ChoiceButtons'
import {
  buildUnifiedKinks,
  readCustomsFirst,
  readKinkGroups,
  sortUnifiedKinks,
  type KinkGroup,
  type UnifiedKink
} from './kinksUnified'
import { KinkRow, parseKinkDrag, KINK_DRAG_MIME } from './KinkRow'
import { useKinkSelection } from './useKinkSelection'

const COLLAPSE_KEY = 'flist-workbench:kinks-pool-group-collapsed'

// Right-pane companion to KinksPane. Two sections:
//   1. Standards, bucketed by F-list category (mapping.kink_groups),
//      each group collapsible (state persisted in localStorage).
//   2. Customs — editable cards (name + description + delete) with a
//      drag handle on the left so the input fields stay focusable.
//      A "+ New custom kink" button creates an empty card.
// Dropping a row from the bucket view onto the pool un-assigns it
// (choice → 'undecided').
export function KinksUndecidedPool() {
  const flistActiveId = useStore((s) => s.flistActiveCharacterId)
  const slot = useStore((s) =>
    flistActiveId ? selectWorkingSlot(s, flistActiveId) : undefined
  )
  const liveArchive = useStore((s) =>
    flistActiveId ? (s.flistArchive[flistActiveId]?.live ?? null) : null
  )
  const readOnly = useStore((s) => s.editorReadOnly)
  const mapping = useStore((s) => s.flistMapping.payload)
  const setStandardKink = useStore((s) => s.flistStandardKinkSet)
  const editCustom = useStore((s) => s.flistCustomKinksEdit)
  const addCustom = useStore((s) => s.flistCustomKinksAdd)
  const tombstoneCustom = useStore((s) => s.flistCustomKinksTombstone)
  const [filter, setFilter] = useState('')
  const [over, setOver] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() =>
    readCollapsed()
  )
  const selection = useKinkSelection()

  useEffect(() => writeCollapsed(collapsed), [collapsed])

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
  const groups = useMemo(() => readKinkGroups(mapping), [mapping])
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
  const standardsFiltered = useMemo(
    () => filtered.filter((u) => u.type === 'standard'),
    [filtered]
  )
  // Customs always appear in the pool — assigned OR undecided — so the
  // user can edit name/description at any time without first dragging
  // the card back to the pool. The pool is the canonical custom editor.
  const allCustoms = useMemo(
    () => unified.filter((u) => u.type === 'custom'),
    [unified]
  )
  const customsFiltered = useMemo(
    () =>
      filterLower
        ? allCustoms.filter((u) => u.name.toLowerCase().includes(filterLower))
        : allCustoms,
    [allCustoms, filterLower]
  )
  const sortedStandards = useMemo(
    () => sortUnifiedKinks(standardsFiltered, customsFirst),
    [standardsFiltered, customsFirst]
  )
  const sortedCustoms = useMemo(
    () =>
      [...customsFiltered].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      ),
    [customsFiltered]
  )
  const standardsByGroup = useMemo(
    () => groupStandards(sortedStandards, groups),
    [sortedStandards, groups]
  )

  const byCompositeId = useMemo(() => {
    const map = new Map<string, UnifiedKink>()
    for (const u of unified) map.set(u.id, u)
    return map
  }, [unified])
  const selectionForDrag = useMemo(() => {
    if (selection.selected.size === 0) return []
    const out: UnifiedKink[] = []
    for (const id of selection.selected) {
      const entry = byCompositeId.get(id)
      if (entry) out.push(entry)
    }
    return out
  }, [selection.selected, byCompositeId])

  const setChoice = useCallback(
    (entries: UnifiedKink[], next: KinkChoice) => {
      if (!flistActiveId) return
      for (const entry of entries) {
        if (entry.choice === next) continue
        if (entry.type === 'standard') {
          setStandardKink(flistActiveId, entry.rawId, next)
        } else {
          editCustom(flistActiveId, entry.rawId, 'choice', next)
        }
      }
    },
    [flistActiveId, setStandardKink, editCustom]
  )

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setOver(false)
      const payload = parseKinkDrag(e)
      if (payload.length === 0) return
      const entries: UnifiedKink[] = []
      for (const item of payload) {
        const entry = unified.find(
          (u) => u.type === item.type && u.rawId === item.id
        )
        if (entry && entry.choice !== 'undecided') entries.push(entry)
      }
      if (entries.length > 0) setChoice(entries, 'undecided')
      selection.clear()
    },
    [unified, setChoice, selection]
  )

  if (!flistActiveId || !sourceSlot) {
    return (
      <div className="kinks-pool kinks-pool-empty">
        <p>No data yet.</p>
      </div>
    )
  }

  return (
    <div
      className={`kinks-pool${over ? ' kinks-pool-over' : ''}${
        readOnly ? ' kinks-pool-readonly' : ''
      }`}
      data-testid="kinks-pool"
      onDragOver={
        readOnly
          ? undefined
          : (e) => {
              if (!e.dataTransfer.types.includes(KINK_DRAG_MIME)) return
              e.preventDefault()
              setOver(true)
            }
      }
      onDragLeave={readOnly ? undefined : () => setOver(false)}
      onDrop={readOnly ? undefined : handleDrop}
    >
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

      <section className="kinks-pool-section" data-testid="kinks-pool-standards">
        <header className="kinks-pool-section-header">
          <h3 className="kinks-pool-section-title">
            Standard kinks{' '}
            <span className="kinks-pool-section-sub">
              {readOnly ? '· read-only' : '· undecided'}
            </span>
          </h3>
          <div className="kinks-pool-section-actions">
            <button
              type="button"
              className="kinks-pool-section-btn"
              onClick={() => {
                const next: Record<string, boolean> = {}
                for (const g of standardsByGroup) next[g.id] = false
                setCollapsed(next)
              }}
              title="Expand every category"
            >
              Expand all
            </button>
            <button
              type="button"
              className="kinks-pool-section-btn"
              onClick={() => setCollapsed({})}
              title="Collapse every category"
            >
              Collapse all
            </button>
          </div>
        </header>
        {standardsByGroup.length === 0 ? (
          <div className="kinks-pool-empty-list">
            {filterLower
              ? 'No standard kinks match that filter.'
              : 'Every standard kink is assigned.'}
          </div>
        ) : (
          <div className="kinks-pool-groups-grid">
            {standardsByGroup.map((g) => {
              // Groups are collapsed by default — the only way to mark
              // a group "open" is to click it, which writes `false`
              // (sentinel for "user-expanded"). Stored separately from
              // a filter expansion so the user's choice survives
              // search-clear.
              const isCollapsed = collapsed[g.id] !== false
              const orderedIds = g.entries.map((u) => u.id)
              return (
                <div
                  key={g.id}
                  className={`kinks-pool-group${isCollapsed ? '' : ' kinks-pool-group-open'}`}
                >
                  <button
                    type="button"
                    className="kinks-pool-group-toggle"
                    aria-expanded={!isCollapsed}
                    onClick={() =>
                      setCollapsed((c) => ({ ...c, [g.id]: !isCollapsed ? true : false }))
                    }
                  >
                    <span className="kinks-pool-group-chev">
                      {isCollapsed ? '▸' : '▾'}
                    </span>
                    <span className="kinks-pool-group-name">{g.name}</span>
                    <span className="kinks-pool-group-count">{g.entries.length}</span>
                  </button>
                  {!isCollapsed && (
                    <ul className="kinks-pool-list">
                      {g.entries.map((entry) => (
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
                </div>
              )
            })}
          </div>
        )}
      </section>

      <hr className="kinks-pool-sep" />

      <section className="kinks-pool-section" data-testid="kinks-pool-customs">
        <header className="kinks-pool-section-header">
          <h3 className="kinks-pool-section-title">
            Custom kinks{' '}
            <span className="kinks-pool-section-sub">
              {readOnly ? '· read-only' : '· always editable'}
            </span>
          </h3>
          {!readOnly && (
            <button
              type="button"
              className="kinks-pool-add"
              onClick={() => addCustom(flistActiveId)}
              data-testid="kinks-pool-add"
            >
              + New custom kink
            </button>
          )}
        </header>
        {sortedCustoms.length === 0 ? (
          <div className="kinks-pool-empty-list">
            {filterLower
              ? 'No custom kinks match that filter.'
              : readOnly
                ? 'No custom kinks on F-list for this character.'
                : 'No custom kinks yet. Click "+ New custom kink" to add one.'}
          </div>
        ) : (
          <ul className="kinks-pool-customs-list">
            {sortedCustoms.map((entry) => (
              <CustomKinkCard
                key={entry.id}
                entry={entry}
                readOnly={readOnly}
                onRename={(value) =>
                  editCustom(flistActiveId, entry.rawId, 'name', value)
                }
                onDescribe={(value) =>
                  editCustom(flistActiveId, entry.rawId, 'description', value)
                }
                onDelete={() => tombstoneCustom(flistActiveId, entry.rawId)}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

interface GroupBucket {
  id: string
  name: string
  entries: UnifiedKink[]
}

function groupStandards(
  standards: UnifiedKink[],
  groups: KinkGroup[]
): GroupBucket[] {
  if (standards.length === 0) return []
  const buckets = new Map<string, GroupBucket>()
  const order: string[] = []
  for (const g of groups) {
    buckets.set(g.id, { id: g.id, name: g.name, entries: [] })
    order.push(g.id)
  }
  const otherId = '__other__'
  for (const entry of standards) {
    const gid = entry.groupId ?? otherId
    let bucket = buckets.get(gid)
    if (!bucket) {
      bucket = { id: gid, name: gid === otherId ? 'Other' : `group#${gid}`, entries: [] }
      buckets.set(gid, bucket)
      order.push(gid)
    }
    bucket.entries.push(entry)
  }
  return order
    .map((id) => buckets.get(id)!)
    .filter((b) => b.entries.length > 0)
}

function readCollapsed(): Record<string, boolean> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY)
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {}
  } catch {
    return {}
  }
}

function writeCollapsed(value: Record<string, boolean>): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify(value))
  } catch {
    // ignore
  }
}

// Inline custom-kink editor card. Local input state mirrors the store
// so per-keystroke React re-renders stay scoped to the card; commits
// flow to the store on idle (250 ms debounce). Dragging is gated to
// the .kink-card-handle so the inputs remain focusable.
function CustomKinkCard({
  entry,
  readOnly,
  onRename,
  onDescribe,
  onDelete
}: {
  entry: UnifiedKink
  readOnly: boolean
  onRename: (value: string) => void
  onDescribe: (value: string) => void
  onDelete: () => void
}) {
  const [name, setName] = useState(entry.name)
  const [description, setDescription] = useState(entry.description)
  // Keep local state in sync if the store value changes externally
  // (e.g. an undo, or another surface editing the same kink).
  useEffect(() => setName(entry.name), [entry.name])
  useEffect(() => setDescription(entry.description), [entry.description])
  // Debounced commit on idle so each keystroke doesn't re-render the
  // unified-kinks selectors above 559+ entries.
  useEffect(() => {
    if (name === entry.name) return
    const t = setTimeout(() => onRename(name), 250)
    return () => clearTimeout(t)
  }, [name, entry.name, onRename])
  useEffect(() => {
    if (description === entry.description) return
    const t = setTimeout(() => onDescribe(description), 250)
    return () => clearTimeout(t)
  }, [description, entry.description, onDescribe])

  return (
    <li
      className={`kink-card${readOnly ? ' kink-card-readonly' : ''}`}
      data-kink-id={entry.id}
      data-kink-choice={entry.choice}
    >
      <span
        className="kink-card-handle"
        draggable={!readOnly}
        title={
          readOnly
            ? 'Read-only'
            : entry.choice === 'undecided'
              ? 'Drag to a bucket on the left'
              : `Drag to move (currently in ${CHOICE_LABELS[entry.choice]})`
        }
        onDragStart={(e) => {
          if (readOnly) {
            e.preventDefault()
            return
          }
          e.dataTransfer.setData(
            KINK_DRAG_MIME,
            JSON.stringify([{ type: 'custom', id: entry.rawId }])
          )
          e.dataTransfer.effectAllowed = 'move'
        }}
        aria-label="Drag handle"
      >
        ⋮⋮
      </span>
      <div className="kink-card-body">
        <div className="kink-card-row">
          <input
            type="text"
            className="kink-card-name"
            value={name}
            placeholder="Custom kink name"
            onChange={(e) => setName(e.target.value)}
            readOnly={readOnly}
            disabled={readOnly}
          />
          <span
            className={`kink-card-choice kink-choice-${entry.choice}`}
            title={`Current choice: ${CHOICE_LABELS[entry.choice]}`}
          >
            {CHOICE_LABELS[entry.choice]}
          </span>
        </div>
        <textarea
          className="kink-card-description"
          value={description}
          placeholder="Description (plain text)"
          rows={2}
          onChange={(e) => setDescription(e.target.value)}
          readOnly={readOnly}
          disabled={readOnly}
        />
      </div>
      {!readOnly && (
        <button
          type="button"
          className="kink-card-delete"
          title="Delete this custom kink"
          onClick={onDelete}
          aria-label="Delete custom kink"
        >
          ✕
        </button>
      )}
    </li>
  )
}
