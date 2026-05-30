import { useEffect, useMemo, useRef, useState } from 'react'
import { Virtuoso } from 'react-virtuoso'
import { useStore } from '../../state'
import { ChoiceButtons, CHOICE_LABELS, CHOICE_ORDER, isKinkChoice, type KinkChoice } from './ChoiceButtons'

interface KinkCatalogueEntry {
  id: string
  name: string
  description: string
  groupId: string
}

interface KinkGroup {
  id: string
  name: string
}

function readChoice(value: unknown): KinkChoice {
  return isKinkChoice(value) ? value : 'undecided'
}

function buildCatalogue(
  mapping: Record<string, unknown> | null
): { kinks: KinkCatalogueEntry[]; groups: KinkGroup[] } {
  if (!mapping) return { kinks: [], groups: [] }
  const kinks: KinkCatalogueEntry[] = []
  const raw = mapping.kinks
  if (Array.isArray(raw)) {
    for (const entry of raw as unknown[]) {
      if (entry && typeof entry === 'object') {
        const e = entry as {
          id?: unknown
          name?: unknown
          description?: unknown
          group_id?: unknown
        }
        if (e.id == null) continue
        kinks.push({
          id: String(e.id),
          name: typeof e.name === 'string' ? (e.name as string) : `kink#${e.id}`,
          description: typeof e.description === 'string' ? (e.description as string) : '',
          groupId: e.group_id != null ? String(e.group_id) : 'misc'
        })
      }
    }
  }
  const groups: KinkGroup[] = []
  const rawGroups = mapping.kink_groups
  if (Array.isArray(rawGroups)) {
    for (const g of rawGroups as unknown[]) {
      if (g && typeof g === 'object') {
        const e = g as { id?: unknown; name?: unknown }
        if (e.id != null) {
          groups.push({
            id: String(e.id),
            name: typeof e.name === 'string' ? (e.name as string) : `group#${e.id}`
          })
        }
      }
    }
  }
  return { kinks, groups }
}

export function StandardKinksPane({ characterId }: { characterId: string }) {
  const slot = useStore((s) => s.flistWorking[characterId])
  const setStandardKink = useStore((s) => s.flistStandardKinkSet)
  const mappingStatus = useStore((s) => s.flistMapping.status)
  const loadMapping = useStore((s) => s.flistLoadMapping)
  const mapping = useStore((s) => s.flistMapping.payload)
  const [filter, setFilter] = useState('')
  // Monotonic counters bumped by the parent's Expand-all / Collapse-all
  // buttons (UX P3-3); columns watch them via useEffect to flip every
  // group at once without bubbling individual collapse state up.
  const [expandSignal, setExpandSignal] = useState(0)
  const [collapseSignal, setCollapseSignal] = useState(0)

  useEffect(() => {
    if (mappingStatus === 'idle') void loadMapping()
  }, [mappingStatus, loadMapping])

  const { kinks, groups } = useMemo(() => buildCatalogue(mapping), [mapping])

  // Build the kink→choice map. Fresh slot or list-shape Live → defaults
  // every catalogue entry to undecided (the §"Fresh-character invariant").
  const choiceById = useMemo<Map<string, KinkChoice>>(() => {
    const map = new Map<string, KinkChoice>()
    const raw = slot?.payload?.kinks
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [id, choice] of Object.entries(raw as Record<string, unknown>)) {
        map.set(id, readChoice(choice))
      }
    }
    for (const entry of kinks) {
      if (!map.has(entry.id)) map.set(entry.id, 'undecided')
    }
    return map
  }, [slot?.payload, kinks])

  const overlay = useMemo(() => new Set(slot?.overlay ?? []), [slot])

  const filterLower = filter.trim().toLowerCase()
  const matches = (entry: KinkCatalogueEntry): boolean => {
    if (!filterLower) return true
    return (
      entry.name.toLowerCase().includes(filterLower) ||
      entry.description.toLowerCase().includes(filterLower)
    )
  }

  if (mappingStatus !== 'ready') {
    return (
      <div className="standard-kinks-pane standard-kinks-loading">
        Loading mapping list…
      </div>
    )
  }

  const buckets: Record<KinkChoice, KinkCatalogueEntry[]> = {
    fave: [],
    yes: [],
    maybe: [],
    no: [],
    undecided: []
  }
  for (const entry of kinks) {
    if (!matches(entry)) continue
    buckets[choiceById.get(entry.id) ?? 'undecided'].push(entry)
  }
  const totalMatching = Object.values(buckets).reduce((n, b) => n + b.length, 0)

  return (
    <div className="standard-kinks-pane" data-testid="standard-kinks-pane">
      <div className="standard-kinks-controls">
        <input
          type="search"
          className="standard-kinks-search"
          placeholder="Search standard kinks…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          data-testid="standard-kinks-search"
        />
        <span className="standard-kinks-summary">{totalMatching} matching</span>
        <button
          type="button"
          className="standard-kinks-expand-all"
          onClick={() => setExpandSignal((n) => n + 1)}
          title="Expand all groups across all columns"
        >
          Expand all
        </button>
        <button
          type="button"
          className="standard-kinks-collapse-all"
          onClick={() => setCollapseSignal((n) => n + 1)}
          title="Collapse all groups across all columns"
        >
          Collapse all
        </button>
      </div>
      {totalMatching === 0 ? (
        <div className="standard-kinks-empty" data-testid="standard-kinks-empty">
          {filterLower
            ? `No kinks match "${filter}". `
            : 'No standard kinks loaded yet. '}
          {filterLower && (
            <button
              type="button"
              className="standard-kinks-empty-clear"
              onClick={() => setFilter('')}
            >
              Clear search
            </button>
          )}
        </div>
      ) : (
        <div className="standard-kinks-columns">
          {CHOICE_ORDER.map((choice) => (
            <StandardKinksColumn
              key={choice}
              characterId={characterId}
              choice={choice}
              entries={buckets[choice]}
              groups={groups}
              onSet={(kinkId, next) => setStandardKink(characterId, kinkId, next)}
              overlay={overlay}
              expandSignal={expandSignal}
              collapseSignal={collapseSignal}
            />
          ))}
        </div>
      )}
    </div>
  )
}

type ColumnRow =
  | { kind: 'group'; groupId: string; label: string; count: number }
  | { kind: 'entry'; entry: KinkCatalogueEntry }

function StandardKinksColumn({
  characterId: _characterId,
  choice,
  entries,
  groups,
  onSet,
  overlay,
  expandSignal,
  collapseSignal
}: {
  characterId: string
  choice: KinkChoice
  entries: KinkCatalogueEntry[]
  groups: KinkGroup[]
  onSet: (kinkId: string, next: KinkChoice) => void
  overlay: Set<string>
  expandSignal: number
  collapseSignal: number
}) {
  // Groups collapsed by default — Tier 3 plan §UX P1-4 / §R-2: with 559
  // entries across 5 columns, mounting every group's rows up-front
  // janks. The user expands the groups they care about.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {}
    for (const g of groups) initial[g.id] = true
    return initial
  })
  // Parent Expand/Collapse-all signals — only react to a new signal,
  // not initial mount (UX P3-3).
  const expandRef = useRef(expandSignal)
  const collapseRef = useRef(collapseSignal)
  useEffect(() => {
    if (expandSignal === expandRef.current) return
    expandRef.current = expandSignal
    setCollapsed((prev) => {
      const next: Record<string, boolean> = {}
      for (const k of Object.keys(prev)) next[k] = false
      for (const g of groups) next[g.id] = false
      return next
    })
  }, [expandSignal, groups])
  useEffect(() => {
    if (collapseSignal === collapseRef.current) return
    collapseRef.current = collapseSignal
    setCollapsed((prev) => {
      const next: Record<string, boolean> = {}
      for (const k of Object.keys(prev)) next[k] = true
      for (const g of groups) next[g.id] = true
      return next
    })
  }, [collapseSignal, groups])
  const flat = useMemo<ColumnRow[]>(() => {
    const groupMap = new Map<string, KinkCatalogueEntry[]>()
    for (const entry of entries) {
      const arr = groupMap.get(entry.groupId) ?? []
      arr.push(entry)
      groupMap.set(entry.groupId, arr)
    }
    const rows: ColumnRow[] = []
    for (const [groupId, list] of groupMap.entries()) {
      const label =
        groups.find((g) => g.id === groupId)?.name ?? `group#${groupId}`
      rows.push({ kind: 'group', groupId, label, count: list.length })
      if (collapsed[groupId] === false) {
        for (const entry of list) rows.push({ kind: 'entry', entry })
      }
    }
    return rows
  }, [entries, groups, collapsed])
  const renderRow = (row: ColumnRow) => {
    if (row.kind === 'group') {
      return (
        <button
          type="button"
          className="standard-kinks-group-toggle"
          aria-expanded={collapsed[row.groupId] === false}
          onClick={() =>
            setCollapsed((prev) => ({
              ...prev,
              [row.groupId]: prev[row.groupId] === false ? true : false
            }))
          }
        >
          {collapsed[row.groupId] === false ? '▾' : '▸'} {row.label} · {row.count}
        </button>
      )
    }
    const entry = row.entry
    return (
      <div className="standard-kinks-entry" title={entry.description}>
        <span className="standard-kinks-entry-name">{entry.name}</span>
        {overlay.has(`kinks.${entry.id}`) && (
          <span className="standard-kinks-entry-overlay" aria-label="Modified">●</span>
        )}
        <ChoiceButtons
          value={choice}
          onChange={(next) => onSet(entry.id, next)}
          variant="compact"
        />
      </div>
    )
  }
  return (
    <div className={`standard-kinks-column standard-kinks-column-${choice}`}>
      <div className="standard-kinks-column-header">
        <span className={`kink-choice-${choice}`}>{CHOICE_LABELS[choice]}</span>
        <span className="standard-kinks-column-count">{entries.length}</span>
      </div>
      {flat.length > 0 ? (
        <Virtuoso
          className="standard-kinks-column-list"
          data={flat}
          itemContent={(_, row) => renderRow(row)}
        />
      ) : (
        <div className="standard-kinks-column-empty">no matches</div>
      )}
    </div>
  )
}

export function countSetStandardKinks(
  slot: { payload: Record<string, unknown> } | undefined
): number {
  if (!slot) return 0
  const raw = slot.payload.kinks
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 0
  let n = 0
  for (const choice of Object.values(raw as Record<string, unknown>)) {
    if (isKinkChoice(choice) && choice !== 'undecided') n++
  }
  return n
}
