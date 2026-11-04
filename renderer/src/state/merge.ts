// The field-by-field merge of two versions of a Workbench (#114): the
// window's (mine, with unsaved edits) and another writer's (theirs, a
// model's tool call, say), both grown from the payload last saved
// (base). The overlay cannot tell which side changed a field: it lists
// what was authored relative to Live, by anyone, and saves never clear
// it. The base can.
//
// Fields, each merged whole:
//   character.<key>     the description is one field: two versions of
//                       the text are never spliced. Custom title, name.
//   infotags.<id>       one profile field.
//   kinks.<id>          one kink's choice.
//   custom_kinks.<id>   one custom kink: name, description, choice,
//                       sub-kinks and its delete mark together.
//   custom_kinks#order  the order of the custom kinks all three versions
//                       hold; a kink added or removed is its own field.
//   images.<id>         one gallery image: being on the gallery, and its
//                       caption.
//   images#order        the order of the gallery images all three hold.
//   <key>               any other top-level key (settings, inlines…).
//
// A field one side left as it was in the base takes the other side's
// value; a field both changed to the same value is that value; a field
// both changed differently is a conflict, settled by `choices` or left
// as mine.
//
// Pure: no store import.

import { isDeepEqual, type WorkingPayload } from './flist'

export type MergeSide = 'mine' | 'theirs'

export interface MergeResult {
  payload: WorkingPayload
  /** Fields both sides changed differently that `choices` does not
   *  settle, in payload order. The payload holds mine there. */
  conflicts: string[]
}

export const GALLERY_ORDER = 'images#order'
export const CUSTOM_KINK_ORDER = 'custom_kinks#order'

/** Containers whose entries are fields of their own. */
const KEYED = new Set(['character', 'infotags', 'kinks', 'custom_kinks'])
/** Marks a keyed container (or the gallery) as present on a side. */
const PRESENT = Object.freeze({ present: true })

type GalleryRow = { image_id: string; sort_order?: number } & Record<string, unknown>
type Fields = Map<string, unknown>

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function galleryOf(payload: WorkingPayload | null): GalleryRow[] {
  const raw = payload?.images
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (r): r is GalleryRow => isPlainObject(r) && typeof r.image_id === 'string'
  )
}

function customKinkOrderOf(payload: WorkingPayload | null): string[] {
  const raw = payload?._custom_kinks_order
  return Array.isArray(raw) ? raw.map(String) : []
}

function fieldsOf(payload: WorkingPayload | null): Fields {
  const out: Fields = new Map()
  if (!payload) return out
  for (const [key, value] of Object.entries(payload)) {
    if (key === '_overlay' || key === '_custom_kinks_order') continue
    // F-list answers `kinks: []` for none; it is the empty container.
    const entries = isPlainObject(value)
      ? value
      : Array.isArray(value) && value.length === 0
        ? {}
        : null
    if (KEYED.has(key) && entries) {
      out.set(key, PRESENT)
      for (const [id, v] of Object.entries(entries)) out.set(`${key}.${id}`, v)
    } else if (key === 'images' && Array.isArray(value)) {
      out.set(key, PRESENT)
      // A row's position is the order field's business, not the row's.
      for (const row of galleryOf(payload)) {
        const rest: Record<string, unknown> = { ...row }
        delete rest.sort_order
        out.set(`images.${row.image_id}`, rest)
      }
    } else {
      out.set(key, value)
    }
  }
  return out
}

/** Each side's sequence cut down to the ids all three hold: the part of
 *  an order the sides can disagree about. An id one side added or
 *  removed is that id's own field. */
function commonOrders(seqs: [string[], string[], string[]]): [string[], string[], string[]] {
  const [b, m, t] = seqs.map((s) => new Set(s))
  const common = (id: string) => b.has(id) && m.has(id) && t.has(id)
  return seqs.map((s) => s.filter(common)) as [string[], string[], string[]]
}

/** The final sequence: the merged order of the ids all three hold, then
 *  every other member placed before the id it preceded on the side it
 *  came from, or last (an image added at the end stays at the end). */
function arrange(order: string[], members: Set<string>, sides: string[][]): string[] {
  const out = order.filter((id) => members.has(id))
  for (const seq of sides) {
    seq.forEach((id, i) => {
      if (!members.has(id) || out.includes(id)) return
      const next = seq.slice(i + 1).find((later) => out.includes(later))
      if (next === undefined) out.push(id)
      else out.splice(out.indexOf(next), 0, id)
    })
  }
  return out
}

/** The field an overlay path belongs to; null for a path that covers
 *  several fields (the gallery's `images`). */
function fieldOfPath(path: string): string | null {
  if (path === 'images') return null
  if (path === 'custom_kinks._order') return CUSTOM_KINK_ORDER
  const segs = path.split('.')
  if (KEYED.has(segs[0]) && segs.length > 1) return `${segs[0]}.${segs[1]}`
  return segs[0]
}

export function mergeWorkbench(
  base: WorkingPayload | null,
  mine: WorkingPayload,
  theirs: WorkingPayload,
  choices: Record<string, MergeSide> = {}
): MergeResult {
  const sides = [base, mine, theirs] as const
  const [b, m, t] = sides.map(fieldsOf)

  const galleries = sides.map(galleryOf)
  const galleryIds = galleries.map((g) => g.map((r) => r.image_id)) as [
    string[],
    string[],
    string[]
  ]
  const kinkOrders = sides.map(customKinkOrderOf) as [string[], string[], string[]]
  const ordered = [
    [GALLERY_ORDER, commonOrders(galleryIds)],
    [CUSTOM_KINK_ORDER, commonOrders(kinkOrders)]
  ] as const
  for (const [key, orders] of ordered) {
    ;[b, m, t].forEach((fields, i) => fields.set(key, orders[i]))
  }

  const keys = [...new Set([...t.keys(), ...m.keys(), ...b.keys()])]
  const merged: Fields = new Map()
  const source = new Map<string, MergeSide | null>()
  const conflicts: string[] = []
  for (const key of keys) {
    const bv = b.get(key)
    const mv = m.get(key)
    const tv = t.get(key)
    if (isDeepEqual(mv, tv)) {
      merged.set(key, mv)
      source.set(key, null)
    } else if (isDeepEqual(mv, bv)) {
      merged.set(key, tv)
      source.set(key, 'theirs')
    } else if (isDeepEqual(tv, bv)) {
      merged.set(key, mv)
      source.set(key, 'mine')
    } else {
      const side = choices[key]
      if (!side) conflicts.push(key)
      merged.set(key, side === 'theirs' ? tv : mv)
      source.set(key, side ?? 'mine')
    }
  }

  const payload: WorkingPayload = {}
  for (const [key, value] of merged) {
    if (value === undefined || key === GALLERY_ORDER || key === CUSTOM_KINK_ORDER) continue
    const dot = key.indexOf('.')
    const top = dot < 0 ? key : key.slice(0, dot)
    if (top === 'images') {
      if (dot < 0) payload.images = []
      continue
    }
    if (dot < 0) {
      if (value === PRESENT) {
        if (!isPlainObject(payload[key])) payload[key] = {}
      } else {
        payload[key] = value
      }
      continue
    }
    if (!isPlainObject(payload[top])) payload[top] = {}
    ;(payload[top] as Record<string, unknown>)[key.slice(dot + 1)] = value
  }

  // The gallery: its members are the images whose field kept them.
  if (Array.isArray(payload.images)) {
    const members = new Set(
      [...merged.keys()]
        .filter((k) => k.startsWith('images.') && merged.get(k) !== undefined)
        .map((k) => k.slice('images.'.length))
    )
    const ids = arrange(merged.get(GALLERY_ORDER) as string[], members, [
      galleryIds[2],
      galleryIds[1]
    ])
    // Positions as the side whose sequence this is had them; renumbered
    // only for a sequence neither side had.
    const like = [galleries[2], galleries[1]].find((g) =>
      isDeepEqual(
        g.map((r) => r.image_id),
        ids
      )
    )
    payload.images = ids.map((id, i) => ({
      ...(merged.get(`images.${id}`) as Record<string, unknown>),
      sort_order: like?.find((r) => r.image_id === id)?.sort_order ?? i
    }))
  }

  // The custom kinks' order, kept only when a side keeps one.
  if ([mine, theirs].some((p) => Array.isArray(p._custom_kinks_order))) {
    const kinks = isPlainObject(payload.custom_kinks) ? payload.custom_kinks : {}
    const listed = new Set([...kinkOrders[1], ...kinkOrders[2]])
    const members = new Set(Object.keys(kinks).filter((id) => listed.has(id)))
    payload._custom_kinks_order = arrange(merged.get(CUSTOM_KINK_ORDER) as string[], members, [
      kinkOrders[2],
      kinkOrders[1]
    ])
  }

  // The overlay: each path as the side its field was taken from has it;
  // for a field both left alike, whichever side changed the path.
  const overlays = sides.map((p) => new Set(Array.isArray(p?._overlay) ? p._overlay : []))
  const [ob, om, ot] = overlays
  const paths = [...new Set([...ot, ...om, ...ob])]
  payload._overlay = paths.filter((path) => {
    const field = fieldOfPath(path)
    const side = field ? source.get(field) : null
    const inMine = om.has(path)
    const inTheirs = ot.has(path)
    if (side === 'mine') return inMine
    if (side === 'theirs') return inTheirs
    if (inMine === inTheirs) return inMine
    return inMine === ob.has(path) ? inTheirs : inMine
  })

  return { payload, conflicts }
}

/** One side's value of a merge field, for showing it: a gallery's or
 *  the custom kinks' whole order for the order fields, undefined for a
 *  field the side does not have. */
export function fieldValue(payload: WorkingPayload, key: string): unknown {
  if (key === GALLERY_ORDER) return galleryOf(payload).map((r) => r.image_id)
  if (key === CUSTOM_KINK_ORDER) return customKinkOrderOf(payload)
  const value = fieldsOf(payload).get(key)
  return value === PRESENT ? undefined : value
}
