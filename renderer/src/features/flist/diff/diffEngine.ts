// Pure diff comparator. Walks `working.json` against a right-hand
// payload (Live or a Backup) and emits a flat ordered DiffRow list
// the renderer paints into a table. Resolver + kink catalogue come in
// as plain arrays so the engine has zero React dependency.

import type { ResolvedInfotagModel } from '../infotagsResolver'
import type { WorkingPayload } from '../../../state/flist'

export type DiffKind = 'unchanged' | 'modified' | 'added' | 'removed'

export type DiffCategory =
  | 'character'
  | 'settings'
  | 'infotag'
  | 'custom_kink'
  | 'standard_kink'
  | 'image'

/** Shape carried in workingValue / rightValue for `image` rows. Lets
 *  the DiffRow renderer reach the thumbnail (via image_id from the row
 *  path) plus the caption + position without re-walking the payload. */
export interface ImageDiffSide {
  present: boolean
  description: string
  position: number
}

export interface DiffRow {
  path: string
  category: DiffCategory
  /** Display label resolved against mapping list. Defaults to the raw
   *  segment when no resolver entry exists. */
  label: string
  /** Working-side value. `undefined` when working has no entry at
   *  this path. */
  workingValue: unknown
  /** Right-side value. `undefined` when right has no entry. */
  rightValue: unknown
  kind: DiffKind
  /** True when this path is in `working._overlay` — drives the
   *  ↺ Reset affordance (only authored paths get a reset action). */
  inOverlay: boolean
  /** Stable ordering hint within a category so sectioning is
   *  deterministic across re-renders. */
  order: number
}

export interface DiffModel {
  rows: DiffRow[]
  counts: Record<DiffKind, number>
  /** Subset of categories where at least one row has kind !==
   *  'unchanged'. Drives the category-filter pill state. */
  changedCategories: Set<DiffCategory>
  /** Total non-unchanged row count — convenient for the tab badge. */
  changedRowCount: number
}

export interface DiffKinkCatalogueEntry {
  id: string
  name: string
}

/** Top-level container picks at the diff input. Tier 4 reads from
 *  the canonical paths; anything not enumerated here is ignored. */
const CHAR_FIELDS = ['name', 'custom_title'] as const
const SETTINGS_FIELDS = [
  'public',
  'customs_first',
  'prevent_bookmarks',
  'show_friends',
  'guestbook'
] as const

function pickContainer(payload: unknown, key: string): Record<string, unknown> {
  if (!payload || typeof payload !== 'object') return {}
  const v = (payload as Record<string, unknown>)[key]
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return v as Record<string, unknown>
  }
  return {}
}

function pickWrappedCharacter(payload: unknown): Record<string, unknown> {
  // F-list serves descriptions either at the top level or inside a
  // `character` wrapper. seedWorkingFromLive normalises into the
  // wrapper; live payloads can do either. Pick the wrapped form when
  // present, else fall back to top-level.
  if (!payload || typeof payload !== 'object') return {}
  const wrapped = (payload as { character?: unknown }).character
  if (wrapped && typeof wrapped === 'object' && !Array.isArray(wrapped)) {
    return wrapped as Record<string, unknown>
  }
  return payload as Record<string, unknown>
}

function pickKinks(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object') return {}
  const k = (payload as { kinks?: unknown }).kinks
  if (k && typeof k === 'object' && !Array.isArray(k)) {
    return k as Record<string, unknown>
  }
  return {}
}

function pickCustomKinks(payload: unknown): Record<string, Record<string, unknown>> {
  if (!payload || typeof payload !== 'object') return {}
  const ck = (payload as { custom_kinks?: unknown }).custom_kinks
  if (ck && typeof ck === 'object' && !Array.isArray(ck)) {
    return ck as Record<string, Record<string, unknown>>
  }
  return {}
}

function isDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || a === undefined || b === undefined) return false
  if (typeof a !== typeof b) return false
  if (typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!isDeepEqual(a[i], b[i])) return false
    }
    return true
  }
  const ao = a as Record<string, unknown>
  const bo = b as Record<string, unknown>
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)])
  for (const k of keys) {
    if (!isDeepEqual(ao[k], bo[k])) return false
  }
  return true
}

function classify(workingVal: unknown, rightVal: unknown): DiffKind {
  const wHas = workingVal !== undefined
  const rHas = rightVal !== undefined
  if (!wHas && rHas) return 'removed'
  if (wHas && !rHas) return 'added'
  if (!wHas && !rHas) return 'unchanged'
  return isDeepEqual(workingVal, rightVal) ? 'unchanged' : 'modified'
}

export function computeDiff(
  workingPayload: WorkingPayload | null,
  rightPayload: Record<string, unknown> | null,
  resolver: ResolvedInfotagModel | null,
  kinkCatalogue: DiffKinkCatalogueEntry[]
): DiffModel {
  const rows: DiffRow[] = []
  const overlay = new Set<string>(
    Array.isArray(workingPayload?._overlay) ? (workingPayload!._overlay as string[]) : []
  )

  const workingChar = pickWrappedCharacter(workingPayload)
  const rightChar = pickWrappedCharacter(rightPayload)
  let order = 0

  // 1) character.description is its own row — text-diff lives in the
  //    renderer, but the engine flags add/rem/modified so the badge +
  //    counts include it.
  {
    const path = 'character.description'
    rows.push({
      path,
      category: 'character',
      label: 'Description',
      workingValue: workingChar.description,
      rightValue: rightChar.description,
      kind: classify(workingChar.description, rightChar.description),
      inOverlay: overlay.has(path),
      order: order++
    })
  }

  // 2) character.{name, custom_title}
  for (const field of CHAR_FIELDS) {
    const path = `character.${field}`
    rows.push({
      path,
      category: 'character',
      label: field === 'custom_title' ? 'Custom title' : 'Name',
      workingValue: workingChar[field],
      rightValue: rightChar[field],
      kind: classify(workingChar[field], rightChar[field]),
      inOverlay: overlay.has(path),
      order: order++
    })
  }

  // 3) settings.<field> — boolean flips
  const workingSettings = pickContainer(workingPayload, 'settings')
  const rightSettings = pickContainer(rightPayload, 'settings')
  for (const field of SETTINGS_FIELDS) {
    const path = `settings.${field}`
    rows.push({
      path,
      category: 'settings',
      label: settingsLabel(field),
      workingValue: workingSettings[field],
      rightValue: rightSettings[field],
      kind: classify(workingSettings[field], rightSettings[field]),
      inOverlay: overlay.has(path),
      order: order++
    })
  }

  // 4) infotags.<id> — union of working + right ids, plus any overlay
  //    path that points at infotags. The latter surfaces an authored
  //    deletion where both sides are now missing the key — without it
  //    the row would silently vanish (QA P2-2).
  const workingInfotags = pickContainer(workingPayload, 'infotags')
  const rightInfotags = pickContainer(rightPayload, 'infotags')
  const infotagIdsSet = new Set([...Object.keys(workingInfotags), ...Object.keys(rightInfotags)])
  for (const p of overlay) {
    if (p.startsWith('infotags.')) infotagIdsSet.add(p.slice('infotags.'.length))
  }
  const infotagIds = Array.from(infotagIdsSet).sort()
  for (const id of infotagIds) {
    const path = `infotags.${id}`
    const descriptor = resolver?.byId.get(id)
    const label = descriptor?.label ?? `info_${id}`
    rows.push({
      path,
      category: 'infotag',
      label,
      workingValue: prettyInfotagValue(workingInfotags[id], descriptor),
      rightValue: prettyInfotagValue(rightInfotags[id], descriptor),
      kind: classify(workingInfotags[id], rightInfotags[id]),
      inOverlay: overlay.has(path),
      order: order++
    })
  }

  // 5) custom_kinks.<id>.{name, description, choice} — walk the union
  const workingCk = pickCustomKinks(workingPayload)
  const rightCk = pickCustomKinks(rightPayload)
  const ckIds = unionKeys(workingCk, rightCk)
  for (const id of ckIds) {
    const w = workingCk[id] ?? {}
    const r = rightCk[id] ?? {}
    // Whole-entry add/remove first — when one side has no row at all.
    if (workingCk[id] === undefined || rightCk[id] === undefined) {
      const path = `custom_kinks.${id}`
      rows.push({
        path,
        category: 'custom_kink',
        label: kinkRowLabel(id, w, r),
        workingValue: workingCk[id],
        rightValue: rightCk[id],
        kind: classify(workingCk[id], rightCk[id]),
        inOverlay: overlay.has(path) || overlay.has(`${path}._deleted`),
        order: order++
      })
      continue
    }
    // Per-field rows. Tombstones (`_deleted: true`) collapse to a
    // single per-entry row marked modified vs the right.
    const tomb = w._deleted === true
    if (tomb) {
      const path = `custom_kinks.${id}._deleted`
      rows.push({
        path,
        category: 'custom_kink',
        label: kinkRowLabel(id, w, r),
        workingValue: 'tombstoned',
        rightValue: 'present',
        kind: 'modified',
        inOverlay: overlay.has(path),
        order: order++
      })
      continue
    }
    for (const field of ['name', 'description', 'choice'] as const) {
      const path = `custom_kinks.${id}.${field}`
      rows.push({
        path,
        category: 'custom_kink',
        label: `${kinkRowLabel(id, w, r)} · ${field}`,
        workingValue: w[field],
        rightValue: r[field],
        kind: classify(w[field], r[field]),
        inOverlay: overlay.has(path),
        order: order++
      })
    }
  }

  // 6) kinks.<id> — union of explicit-choice ids on either side
  const workingK = pickKinks(workingPayload)
  const rightK = pickKinks(rightPayload)
  const explicit = (v: unknown) =>
    typeof v === 'string' && v !== '' && v !== 'undecided'
  const kinkIds = new Set<string>()
  for (const [id, val] of Object.entries(workingK)) if (explicit(val)) kinkIds.add(id)
  for (const [id, val] of Object.entries(rightK)) if (explicit(val)) kinkIds.add(id)
  // Also include any path the user touched, even if the value happens
  // to be `undecided` now — overlay is authoritative.
  for (const p of overlay) {
    if (p.startsWith('kinks.')) kinkIds.add(p.slice('kinks.'.length))
  }
  const kinkLookup = new Map(kinkCatalogue.map((k) => [k.id, k.name]))
  for (const id of Array.from(kinkIds).sort()) {
    const path = `kinks.${id}`
    rows.push({
      path,
      category: 'standard_kink',
      label: kinkLookup.get(id) ?? id,
      workingValue: workingK[id] ?? 'undecided',
      rightValue: rightK[id] ?? 'undecided',
      kind: classify(workingK[id], rightK[id]),
      inOverlay: overlay.has(path),
      order: order++
    })
  }

  // 7) images.<image_id> — union of the gallery on either side. A row
  //    is `modified` when caption or position changed; `added` when
  //    working has the image but right doesn't (or vice versa for
  //    `removed`). The whole `images` array is one overlay path so
  //    every image row shares the same inOverlay flag.
  const workingImages = pickGallery(workingPayload)
  const rightImages = pickGallery(rightPayload)
  const imageIds = new Set<string>([
    ...workingImages.keys(),
    ...rightImages.keys()
  ])
  const imagesInOverlay = overlay.has('images')
  for (const id of Array.from(imageIds).sort(imageIdComparator(workingImages, rightImages))) {
    const w = workingImages.get(id)
    const r = rightImages.get(id)
    const workingValue: ImageDiffSide | undefined = w
      ? { present: true, description: w.description, position: w.position }
      : undefined
    const rightValue: ImageDiffSide | undefined = r
      ? { present: true, description: r.description, position: r.position }
      : undefined
    rows.push({
      path: `images.${id}`,
      category: 'image',
      label: id.startsWith('local-') ? `Local · ${id.slice(6)}` : `Image ${id}`,
      workingValue,
      rightValue,
      kind: classify(workingValue, rightValue),
      inOverlay: imagesInOverlay,
      order: order++
    })
  }

  const counts: Record<DiffKind, number> = {
    unchanged: 0,
    modified: 0,
    added: 0,
    removed: 0
  }
  const changedCategories = new Set<DiffCategory>()
  for (const row of rows) {
    counts[row.kind]++
    if (row.kind !== 'unchanged') changedCategories.add(row.category)
  }
  const changedRowCount = counts.modified + counts.added + counts.removed
  return { rows, counts, changedCategories, changedRowCount }
}

function pickGallery(
  payload: unknown
): Map<string, { description: string; position: number }> {
  const out = new Map<string, { description: string; position: number }>()
  if (!payload || typeof payload !== 'object') return out
  const raw = (payload as { images?: unknown }).images
  if (!Array.isArray(raw)) return out
  // Walk in array order so `position` is stable even when sort_order
  // is missing or malformed — that's also how every other consumer of
  // working.images reads the list.
  const sorted = raw
    .map((entry, idx) => ({ entry, idx }))
    .sort((a, b) => {
      const so = (e: unknown): number => {
        if (!e || typeof e !== 'object') return 0
        const v = (e as { sort_order?: unknown }).sort_order
        return typeof v === 'number' ? v : Number(v ?? 0) || 0
      }
      return so(a.entry) - so(b.entry)
    })
  let position = 0
  for (const { entry } of sorted) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as { image_id?: unknown; description?: unknown }
    if (typeof e.image_id !== 'string') continue
    out.set(e.image_id, {
      description: typeof e.description === 'string' ? e.description : '',
      position
    })
    position++
  }
  return out
}

function imageIdComparator(
  working: Map<string, { description: string; position: number }>,
  right: Map<string, { description: string; position: number }>
) {
  // Order rows by working-side position first (so the diff reads top-
  // down like the gallery), then by right-side position for ids that
  // only exist on the right, then lexicographically as a tiebreak.
  return (a: string, b: string): number => {
    const wa = working.get(a)?.position
    const wb = working.get(b)?.position
    if (wa !== undefined && wb !== undefined) return wa - wb
    if (wa !== undefined) return -1
    if (wb !== undefined) return 1
    const ra = right.get(a)?.position ?? 0
    const rb = right.get(b)?.position ?? 0
    if (ra !== rb) return ra - rb
    return a < b ? -1 : a > b ? 1 : 0
  }
}

function unionKeys(
  a: Record<string, unknown>,
  b: Record<string, unknown>
): string[] {
  const set = new Set<string>([...Object.keys(a), ...Object.keys(b)])
  return Array.from(set).sort()
}

function settingsLabel(field: (typeof SETTINGS_FIELDS)[number]): string {
  switch (field) {
    case 'public':
      return 'Public profile'
    case 'customs_first':
      return 'Show custom kinks first'
    case 'prevent_bookmarks':
      return 'Prevent bookmarks'
    case 'show_friends':
      return 'Show friends'
    case 'guestbook':
      return 'Enable guestbook'
  }
}

function prettyInfotagValue(
  raw: unknown,
  descriptor:
    | { type: string; listItems?: { value: string; label: string }[] }
    | undefined
): unknown {
  // Resolve `list` infotag values from the listitem id to the human
  // label so a diff row reads "Human" not "10". Leaves text/number
  // values alone.
  if (raw === undefined || raw === null) return raw
  if (descriptor?.type === 'list' && Array.isArray(descriptor.listItems)) {
    const match = descriptor.listItems.find((item) => item.value === String(raw))
    if (match) return match.label
  }
  return raw
}

function kinkRowLabel(
  id: string,
  working: Record<string, unknown>,
  right: Record<string, unknown>
): string {
  const name =
    (typeof working.name === 'string' && working.name) ||
    (typeof right.name === 'string' && right.name) ||
    (id.startsWith('local:') ? 'New kink' : `kink#${id}`)
  return name
}
