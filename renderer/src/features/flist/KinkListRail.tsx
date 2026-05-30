import { useMemo } from 'react'
import { useStore } from '../../state'
import type { KinkChoice } from './ChoiceButtons'

interface KinkRow {
  id: string
  name: string
  choice: KinkChoice
  isLocal: boolean
  isDeleted: boolean
  overlaid: boolean
}

function readChoice(value: unknown): KinkChoice {
  if (
    value === 'fave' ||
    value === 'yes' ||
    value === 'maybe' ||
    value === 'no' ||
    value === 'undecided'
  ) {
    return value
  }
  return 'undecided'
}

export function KinkListRail({ characterId }: { characterId: string }) {
  const slot = useStore((s) => s.flistWorking[characterId])
  const ui = useStore((s) => s.flistCustomKinksUI[characterId])
  const setUI = useStore((s) => s.flistCustomKinksSetUI)
  const select = useStore((s) => s.flistCustomKinksSelect)
  const toggleMulti = useStore((s) => s.flistCustomKinksToggleMulti)
  const add = useStore((s) => s.flistCustomKinksAdd)

  const rows = useMemo<KinkRow[]>(() => {
    if (!slot) return []
    const ck =
      (slot.payload.custom_kinks as Record<string, Record<string, unknown>> | undefined) ?? {}
    const order = Array.isArray(slot.payload._custom_kinks_order)
      ? (slot.payload._custom_kinks_order as string[])
      : Object.keys(ck)
    // Union: persisted order first, then any in-dict-not-in-order ids
    // appended at render time. This handles Case C (Live re-pull adds
    // a kink) WITHOUT persisting the order array until the user makes
    // their first edit — per Tier 3 plan §R-4. QA P1-1.
    const orderSet = new Set(order)
    const extras = Object.keys(ck).filter((id) => !orderSet.has(id))
    const allIds = [...order, ...extras]
    const overlay = new Set(slot.overlay)
    const out: KinkRow[] = []
    for (const id of allIds) {
      const entry = ck[id]
      if (!entry) continue
      const overlaid = Array.from(overlay).some(
        (p) =>
          p.startsWith(`custom_kinks.${id}.`) &&
          p !== `custom_kinks.${id}._deleted`
      )
      out.push({
        id,
        name: typeof entry.name === 'string' ? (entry.name as string) : `kink ${id}`,
        choice: readChoice(entry.choice),
        isLocal: id.startsWith('local:'),
        isDeleted: entry._deleted === true,
        overlaid
      })
    }
    return out
  }, [slot])

  const filter = ui?.filter ?? ''
  const sort = ui?.sort ?? 'insertion'
  const showDeleted = ui?.showDeleted ?? false
  const filterLower = filter.trim().toLowerCase()

  const visible = useMemo(() => {
    let result = rows.filter((r) => showDeleted || !r.isDeleted)
    if (filterLower) {
      result = result.filter((r) => r.name.toLowerCase().includes(filterLower))
    }
    if (sort === 'name') {
      result = [...result].sort((a, b) => a.name.localeCompare(b.name))
    } else if (sort === 'choice') {
      const choiceRank: Record<KinkChoice, number> = {
        fave: 0,
        yes: 1,
        maybe: 2,
        no: 3,
        undecided: 4
      }
      result = [...result].sort((a, b) => choiceRank[a.choice] - choiceRank[b.choice])
    }
    return result
  }, [rows, filterLower, sort, showDeleted])

  // Disambiguate duplicate names with (2), (3) suffixes — matches user
  // intent of name-prefix grouping (e.g. "├ Rassen", "├ Rassen", "├ Rassen").
  const nameCounts = new Map<string, number>()
  const disambiguated = visible.map((row) => {
    const baseCount = nameCounts.get(row.name) ?? 0
    nameCounts.set(row.name, baseCount + 1)
    const label = baseCount === 0 ? row.name : `${row.name} (${baseCount + 1})`
    return { ...row, label }
  })

  return (
    <div className="kink-rail" data-testid="kink-rail">
      <div className="kink-rail-controls">
        <input
          type="search"
          className="kink-rail-filter"
          placeholder="Filter kinks…"
          value={filter}
          onChange={(e) => setUI(characterId, { filter: e.target.value })}
        />
        <select
          className="kink-rail-sort"
          value={sort}
          aria-label="Sort kinks"
          title="Sort kinks"
          onChange={(e) =>
            setUI(characterId, {
              sort: e.target.value as 'insertion' | 'name' | 'choice'
            })
          }
        >
          <option value="insertion">Sort: insertion order</option>
          <option value="name">Sort: name (A–Z)</option>
          <option value="choice">Sort: choice</option>
        </select>
        <label className="kink-rail-show-deleted">
          <input
            type="checkbox"
            checked={showDeleted}
            onChange={(e) => setUI(characterId, { showDeleted: e.target.checked })}
          />
          Show deleted
        </label>
        <button
          type="button"
          className="kink-rail-add"
          onClick={() => add(characterId)}
          data-testid="kink-rail-add"
        >
          + Add
        </button>
      </div>
      <p className="kink-rail-tip">Tip: Shift/Ctrl-click rows for multi-select.</p>
      <ul className="kink-rail-list">
        {disambiguated.length === 0 && (
          <li className="kink-rail-empty">
            {rows.length === 0
              ? 'No custom kinks yet. Click + Add to create one.'
              : `No matches for "${filter}". Clear filter to see all.`}
          </li>
        )}
        {disambiguated.map((row) => {
          const selected = ui?.selectedKinkId === row.id
          const multi = (ui?.selectedKinkIds ?? []).includes(row.id)
          const rowsInOrder = disambiguated.map((r) => r.id)
          return (
            <li
              key={row.id}
              className={`kink-rail-row${selected ? ' kink-rail-row-selected' : ''}${
                row.isDeleted ? ' kink-rail-row-deleted' : ''
              }${multi ? ' kink-rail-row-multi' : ''}`}
              data-testid={`kink-rail-row-${row.id}`}
            >
              <button
                type="button"
                className="kink-rail-row-pick"
                onClick={(e) => {
                  if (e.shiftKey) {
                    toggleMulti(characterId, row.id, { range: true, rowsInOrder })
                  } else if (e.ctrlKey || e.metaKey) {
                    toggleMulti(characterId, row.id)
                  } else {
                    select(characterId, row.id)
                  }
                }}
              >
                <span
                  className={`kink-rail-dot kink-choice-${row.choice}`}
                  aria-label={`Choice: ${row.choice}`}
                />
                <span className="kink-rail-row-name">{row.label}</span>
                {row.isLocal && (
                  <span className="kink-rail-row-pill" title="Added in working copy, not yet on F-list">
                    new
                  </span>
                )}
                {row.overlaid && !row.isDeleted && (
                  <span className="kink-rail-row-overlay" aria-label="Modified">
                    ●
                  </span>
                )}
                {row.isDeleted && (
                  <span className="kink-rail-row-tombstone" aria-label="Tombstoned">
                    ⊖
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
