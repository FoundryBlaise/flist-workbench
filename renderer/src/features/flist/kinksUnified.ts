// Merges standard kinks (catalogue + working-copy choice map) and custom
// kinks (working-copy dict, excluding tombstones) into a single list
// the Kinks tab and the Undecided pool both consume. Pure module — no
// React, no store imports — so it can be tested in isolation.

import { isKinkChoice, type KinkChoice } from './ChoiceButtons'

export type UnifiedKinkType = 'standard' | 'custom'

export interface UnifiedKink {
  /** Composite key for React lists. `std:<id>` or `cst:<id>`. */
  id: string
  /** The id as it appears in the working copy (without the type prefix). */
  rawId: string
  type: UnifiedKinkType
  name: string
  description: string
  choice: KinkChoice
  /** F-list-side category id (mapping.kink_groups). Only populated for
   *  standards; customs don't carry a group. */
  groupId?: string
}

interface CatalogueEntry {
  id: string
  name: string
  description: string
  groupId: string
}

export interface KinkGroup {
  id: string
  name: string
}

function readChoice(value: unknown): KinkChoice {
  return isKinkChoice(value) ? value : 'undecided'
}

function buildStandardCatalogue(
  mapping: Record<string, unknown> | null
): CatalogueEntry[] {
  if (!mapping) return []
  const out: CatalogueEntry[] = []
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
        out.push({
          id: String(e.id),
          name: typeof e.name === 'string' ? e.name : `kink#${e.id}`,
          description: typeof e.description === 'string' ? e.description : '',
          groupId: e.group_id != null ? String(e.group_id) : 'misc'
        })
      }
    }
  }
  return out
}

export function readKinkGroups(
  mapping: Record<string, unknown> | null
): KinkGroup[] {
  if (!mapping) return []
  const raw = mapping.kink_groups
  if (!Array.isArray(raw)) return []
  const out: KinkGroup[] = []
  for (const entry of raw as unknown[]) {
    if (entry && typeof entry === 'object') {
      const e = entry as { id?: unknown; name?: unknown }
      if (e.id == null) continue
      out.push({
        id: String(e.id),
        name: typeof e.name === 'string' ? e.name : `group#${e.id}`
      })
    }
  }
  return out
}

export function buildUnifiedKinks(
  slot: { payload: Record<string, unknown> } | undefined,
  mapping: Record<string, unknown> | null
): UnifiedKink[] {
  if (!slot) return []
  const catalogue = buildStandardCatalogue(mapping)
  const choices =
    (slot.payload.kinks as Record<string, unknown> | undefined) ?? {}
  const standards: UnifiedKink[] = catalogue.map((entry) => ({
    id: `std:${entry.id}`,
    rawId: entry.id,
    type: 'standard',
    name: entry.name,
    description: entry.description,
    choice: readChoice(choices[entry.id]),
    groupId: entry.groupId
  }))
  const customsDict =
    (slot.payload.custom_kinks as Record<string, Record<string, unknown>> | undefined) ??
    {}
  const customs: UnifiedKink[] = []
  for (const [id, entry] of Object.entries(customsDict)) {
    if (!entry || entry._deleted === true) continue
    customs.push({
      id: `cst:${id}`,
      rawId: id,
      type: 'custom',
      name: typeof entry.name === 'string' && entry.name.trim()
        ? entry.name
        : 'New custom kink',
      description:
        typeof entry.description === 'string' ? entry.description : '',
      choice: readChoice(entry.choice)
    })
  }
  return [...standards, ...customs]
}

export function sortUnifiedKinks(
  list: UnifiedKink[],
  customsFirst: boolean
): UnifiedKink[] {
  const sorted = [...list]
  if (customsFirst) {
    sorted.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'custom' ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })
  } else {
    sorted.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    )
  }
  return sorted
}

export type Buckets = Record<KinkChoice, UnifiedKink[]>

export function bucketByChoice(list: UnifiedKink[]): Buckets {
  const buckets: Buckets = { fave: [], yes: [], maybe: [], no: [], undecided: [] }
  for (const entry of list) buckets[entry.choice].push(entry)
  return buckets
}

export function readCustomsFirst(
  slot: { payload: Record<string, unknown> } | undefined
): boolean {
  if (!slot) return false
  const settings = slot.payload.settings as Record<string, unknown> | undefined
  return settings?.customs_first === true
}

/** Tab-badge count: kinks with any choice other than undecided
 *  (customs + standards combined). Doesn't need the catalogue —
 *  reads directly from the working copy. */
export function countKinksWithChoice(
  slot: { payload: Record<string, unknown> } | undefined
): number {
  if (!slot) return 0
  let n = 0
  const stds = (slot.payload.kinks as Record<string, unknown> | undefined) ?? {}
  for (const v of Object.values(stds)) {
    if (isKinkChoice(v) && v !== 'undecided') n++
  }
  const ck =
    (slot.payload.custom_kinks as Record<string, Record<string, unknown>> | undefined) ??
    {}
  for (const v of Object.values(ck)) {
    if (!v || v._deleted === true) continue
    if (isKinkChoice(v.choice) && v.choice !== 'undecided') n++
  }
  return n
}
