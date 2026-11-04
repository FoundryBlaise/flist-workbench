// Constants more than one view reads: the Workbench's tabs, the Diff tab
// and the Foreign profile view. They are defined here, not in a
// component, so two views cannot disagree about them. Pure module: no
// React, no store.

// ---- Kink choices -----------------------------------------------------

export type KinkChoice = 'fave' | 'yes' | 'maybe' | 'no' | 'undecided'

export function isKinkChoice(value: unknown): value is KinkChoice {
  return (
    value === 'fave' ||
    value === 'yes' ||
    value === 'maybe' ||
    value === 'no' ||
    value === 'undecided'
  )
}

/** The assigned choices, in the order their columns appear. Undecided
 *  is not a column: the editor shows it as a separate pool, the Foreign
 *  view not at all. */
export const KINK_BUCKET_ORDER: readonly KinkChoice[] = ['fave', 'yes', 'maybe', 'no']

/** Every choice, in the order the choice buttons offer them. */
export const CHOICE_ORDER: readonly KinkChoice[] = [...KINK_BUCKET_ORDER, 'undecided']

export const CHOICE_LABELS: Record<KinkChoice, string> = {
  fave: '★ Fave',
  yes: 'Yes',
  maybe: 'Maybe',
  no: 'No',
  undecided: '– Undecided'
}

// Compact variant labels — explicit map vs regex-strip of CHOICE_LABELS
// (QA P3-2: prefix-glyph changes would otherwise silently break compact).
export const CHOICE_LABELS_COMPACT: Record<KinkChoice, string> = {
  fave: 'Fave',
  yes: 'Yes',
  maybe: 'Maybe',
  no: 'No',
  undecided: 'Undecided'
}

// ---- Drag types -------------------------------------------------------
// Custom types so they don't conflict with the system's text/uri-list or
// text/plain that drag events also dispatch.

/** A kink row dragged between the Kinks tab's columns and the Undecided
 *  pool. */
export const KINK_DRAG_MIME = 'application/x-kink-id'

/** An image dragged out of the gallery into the Pool. Each direction has
 *  its own type so a drop handler can refuse the wrong direction. */
export const DRAG_MIME_PROFILE_TO_POOL = 'application/x-flist-image-to-pool'

/** An image dragged from the Pool into the gallery. */
export const DRAG_MIME_POOL_TO_PROFILE = 'application/x-flist-image-to-profile'

/** A gallery image dragged onto another to reorder the gallery. The
 *  Images tab and the gallery preview both accept it, so a reorder in
 *  one shows in the other through the Workbench's `images`. */
export const DRAG_MIME_GALLERY_REORDER = 'application/x-flist-gallery-reorder'

// ---- Diff tab ---------------------------------------------------------

/** What the Workbench is compared with until the user picks a Backup.
 *  One module-level object: Zustand selectors compare by identity, so a
 *  `?? { kind: 'live' }` inline would allocate a fresh object every
 *  render and loop re-rendering. */
export const DEFAULT_DIFF_RIGHT_SOURCE = { kind: 'live' } as const
