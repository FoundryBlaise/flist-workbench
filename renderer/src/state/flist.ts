// F-list working-copy persistence helpers (Phase 7 Tier 2+).
//
// Pure functions only — no Zustand wiring lives here. The store imports
// these to seed/apply/diff working.json payloads without growing the
// state.ts surface further. Helpers cover:
//
//   - resolving dotted overlay paths (`character.description`,
//     `infotags.info_9`, `custom_kinks.local:abc.name`, …)
//   - seeding a fresh working slot from a Live payload
//   - drift detection between two Live snapshots for a known overlay
//   - empty-state conventions (cleared infotags are absent, not "")
//
// Tier 3 adds custom-kinks order normalisation + drift suppression for
// the `children` array — same conventions, kept here so the store stays
// thin.

import type { InlineImage } from '../lib/api'

export type WorkingPayload = Record<string, unknown> & {
  _schema_version?: number
  _overlay?: string[]
}

export type FlistSaveStatus = 'idle' | 'saving' | 'saved' | 'error'

export interface FlistWorkingSlot {
  payload: WorkingPayload
  /** Dotted paths the user has authored on this working copy. */
  overlay: string[]
  /** sha256 from the last successful read or write; null on fresh seed. */
  etag: string | null
  /** True after a user edit that hasn't been persisted yet. */
  unsavedDirty: boolean
  saveStatus: FlistSaveStatus
  saveError: string | null
  /** Unix-ms of the last successful save. */
  lastSavedAt: number | null
  /** Materialised-on-first-edit. False while the slot is a seed-from-Live
   *  preview that has never been written to disk. Flips true on the first
   *  successful PUT. */
  materialised: boolean
}

export const WORKING_SCHEMA_VERSION = 2

// Top-level container keys carried by working.json. Renderer flushes the
// whole payload — unknown keys (older + future tiers) round-trip cleanly.
export const WORKING_CONTAINER_KEYS = [
  'character',
  'settings',
  'infotags',
  'kinks',
  'custom_kinks',
  'images',
  'inlines'
] as const

// ---- dotted-path access ---------------------------------------------

/** Split a dotted overlay path into raw segments. Tier 3 keys can carry
 *  `local:<uuid>` ids whose colon is part of the segment, so this is
 *  the only place that decides how segments tokenize — currently a flat
 *  `.` split.
 */
export function pathSegments(path: string): string[] {
  return path.split('.')
}

export function pathLookup(
  payload: WorkingPayload,
  path: string
): unknown {
  const segs = pathSegments(path)
  let cursor: unknown = payload
  for (const seg of segs) {
    if (cursor === null || cursor === undefined) return undefined
    if (typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[seg]
  }
  return cursor
}

/** Set a value at `path`, creating intermediate objects as needed.
 *  Mutates `payload` in place — callers should clone first if Zustand
 *  needs structural identity. Returns the mutated payload for fluent use.
 *
 *  Arrays at an intermediate segment are converted to `{}` (defensive
 *  guard — F-list returns `kinks: []` when empty and a `pathSet` on it
 *  would otherwise set a non-numeric property). Strings/numbers at an
 *  intermediate segment are similarly replaced because they cannot
 *  carry child keys (QA P3-10).
 */
export function pathSet(
  payload: WorkingPayload,
  path: string,
  value: unknown
): WorkingPayload {
  const segs = pathSegments(path)
  if (segs.length === 0) return payload
  let cursor: Record<string, unknown> = payload
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i]
    const next = cursor[seg]
    if (
      next === null ||
      next === undefined ||
      typeof next !== 'object' ||
      Array.isArray(next)
    ) {
      cursor[seg] = {}
    }
    cursor = cursor[seg] as Record<string, unknown>
  }
  cursor[segs[segs.length - 1]] = value
  return payload
}

/** Delete the value at `path`. Walks intermediate objects best-effort —
 *  no-op if any intermediate segment is missing. */
export function pathDelete(payload: WorkingPayload, path: string): void {
  const segs = pathSegments(path)
  if (segs.length === 0) return
  let cursor: Record<string, unknown> = payload
  for (let i = 0; i < segs.length - 1; i++) {
    const next = cursor[segs[i]]
    if (next === null || next === undefined || typeof next !== 'object') return
    cursor = next as Record<string, unknown>
  }
  delete cursor[segs[segs.length - 1]]
}

// ---- seed-from-Live --------------------------------------------------

/** F-list serves descriptions with literal CRLF / CR — duplicated from
 *  state.ts so this module is self-contained. */
export function normaliseNewlines(s: string): string {
  return s.replace(/\r\n?/g, '\n')
}

/** Build a fresh working payload from a Live snapshot. The renderer
 *  treats the result as a *preview* — `materialised: false` — so a Live
 *  re-pull still flows through to the editor until the user makes the
 *  first edit. */
export function seedWorkingFromLive(live: Record<string, unknown>): WorkingPayload {
  const out: WorkingPayload = {
    _schema_version: WORKING_SCHEMA_VERSION,
    _overlay: []
  }
  // Live may carry a {character: {...}, settings: ..., ...} wrapper or
  // come pre-flattened — handle both by trusting whichever shape exists.
  const wrapper = (live.character ?? null) as Record<string, unknown> | null
  if (wrapper) {
    out.character = { ...wrapper }
    if (typeof (out.character as Record<string, unknown>).description === 'string') {
      const c = out.character as Record<string, unknown>
      c.description = normaliseNewlines(c.description as string)
    }
  } else if (typeof live.description === 'string') {
    out.character = {
      id: live.id,
      name: live.name,
      description: normaliseNewlines(live.description),
      custom_title: live.custom_title
    }
  }
  for (const key of WORKING_CONTAINER_KEYS) {
    if (key === 'character') continue
    const value = (live as Record<string, unknown>)[key]
    if (value === undefined) continue
    // F-list returns `kinks: []` when nothing's set (probe-verified
    // 2026-05-30) but a populated character has `kinks: {fetish_id:
    // choice}`. Reshape on seed so downstream code (pathSet, KinksPane
    // unified-kinks reader, ZIP serialiser) always sees a dict.
    if (key === 'kinks' && Array.isArray(value)) {
      out.kinks = {}
      continue
    }
    out[key] = value
  }
  // Tier 3 invariant: when custom_kinks is a dict, materialise the order
  // array so the rail renders insertion-order without a fresh edit.
  const ck = out.custom_kinks
  if (ck && typeof ck === 'object' && !Array.isArray(ck) && !('_custom_kinks_order' in out)) {
    out._custom_kinks_order = Object.keys(ck as Record<string, unknown>)
  }
  return out
}

/** Empty slot for use as the initial render state before /working has
 *  resolved (load=idle/loading). */
export function emptyWorkingSlot(): FlistWorkingSlot {
  return {
    payload: { _schema_version: WORKING_SCHEMA_VERSION, _overlay: [] },
    overlay: [],
    etag: null,
    unsavedDirty: false,
    saveStatus: 'idle',
    saveError: null,
    lastSavedAt: null,
    materialised: false
  }
}

// ---- drift detection -------------------------------------------------

/** Compare an old Live snapshot to a new one across a set of paths.
 *  Returns the subset whose `pathLookup` differs. Used by the Profile-
 *  fields tab's "F-list-side change in N fields" banner. */
export function detectLiveDrift(
  oldLive: Record<string, unknown> | null,
  newLive: Record<string, unknown>,
  candidates: string[],
  ignorePaths: string[] = []
): string[] {
  if (oldLive === null) return []
  const ignore = new Set(ignorePaths)
  const out: string[] = []
  for (const path of candidates) {
    if (ignore.has(path)) continue
    const before = pathLookup(oldLive as WorkingPayload, path)
    const after = pathLookup(newLive as WorkingPayload, path)
    if (!isDeepEqual(before, after)) out.push(path)
  }
  return out
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

// ---- editing helpers -------------------------------------------------

/** Apply a user edit at `path` and mark the path overlaid. Returns a
 *  *new* slot — never mutates the input. Tier 2 empty-state convention:
 *  clearing an infotag deletes the key rather than serialising "". */
export function applyEdit(
  slot: FlistWorkingSlot,
  path: string,
  value: unknown
): FlistWorkingSlot {
  const payload = structuredCloneSafe(slot.payload)
  if (isInfotagPath(path) && (value === '' || value === null || value === undefined)) {
    pathDelete(payload, path)
  } else {
    pathSet(payload, path, value)
  }
  const overlay = slot.overlay.includes(path) ? slot.overlay : [...slot.overlay, path]
  payload._overlay = [...overlay]
  // Keep the prior saveError around so a 409 refresh-or-overwrite banner
  // isn't silently dismissed by the next keystroke (QA P3-2). Status
  // resets to 'idle' so the chip stops claiming "saving" or "saved".
  return {
    ...slot,
    payload,
    overlay,
    unsavedDirty: true,
    saveStatus: 'idle',
    saveError: slot.saveError
  }
}

/** Strip `path` from overlay and write Live's value (or delete the key
 *  when path is an infotag and Live doesn't carry it). */
export function applyReset(
  slot: FlistWorkingSlot,
  live: Record<string, unknown> | null,
  path: string
): FlistWorkingSlot {
  const payload = structuredCloneSafe(slot.payload)
  const liveValue =
    live === null ? undefined : pathLookup(live as WorkingPayload, path)
  if (liveValue === undefined && isInfotagPath(path)) {
    pathDelete(payload, path)
  } else if (liveValue === undefined) {
    pathDelete(payload, path)
  } else {
    pathSet(payload, path, liveValue)
  }
  const overlay = slot.overlay.filter((p) => p !== path)
  payload._overlay = [...overlay]
  return {
    ...slot,
    payload,
    overlay,
    unsavedDirty: true,
    saveStatus: 'idle',
    saveError: null
  }
}

/** structuredClone fallback for older Electron — safe deep copy of plain
 *  JSON-like payloads. */
function structuredCloneSafe<T>(value: T): T {
  // Node ≥17 and modern Electron have structuredClone.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fn = (globalThis as any).structuredClone
  if (typeof fn === 'function') return fn(value)
  return JSON.parse(JSON.stringify(value)) as T
}

export function isInfotagPath(path: string): boolean {
  return path.startsWith('infotags.')
}

// ---- inline-image extractor (duplicated from state.ts) ---------------

/** Working-copy slots need the Live's inline manifest so `[img=<id>]`
 *  tags resolve — keep a copy here so the helper can run without
 *  pulling on state.ts. */
export function extractInlines(payload: unknown): Record<string, InlineImage> {
  if (!payload || typeof payload !== 'object') return {}
  const raw = (payload as { inlines?: unknown }).inlines
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, InlineImage> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (
      v &&
      typeof v === 'object' &&
      typeof (v as { hash?: unknown }).hash === 'string' &&
      typeof (v as { extension?: unknown }).extension === 'string'
    ) {
      const entry = v as { hash: string; extension: string; nsfw?: unknown }
      out[String(k)] = {
        hash: entry.hash,
        extension: entry.extension,
        nsfw: Boolean(entry.nsfw)
      }
    }
  }
  return out
}

// ---- description path -------------------------------------------------

/** The canonical overlay path for the BBCode description. CodeMirror's
 *  `setEditorContent` plumbs through here so the Description tab and
 *  the underlying working.json stay in lockstep. */
export const DESCRIPTION_PATH = 'character.description'

export function descriptionOf(payload: WorkingPayload): string {
  const v = pathLookup(payload, DESCRIPTION_PATH)
  if (typeof v !== 'string') return ''
  return normaliseNewlines(v)
}
