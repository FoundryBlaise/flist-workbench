// An undo or redo that brings back a gallery image whose file has since
// gone to the Trash. The store puts the file back from the Trash
// before the undone payload is saved and says so in a note; these are
// the pure parts of that: which images to look for, how the gallery
// follows a file that came back under another id, and the note.

import type { WorkingPayload } from './flist'

type GalleryRow = { image_id: string; description: string; sort_order: number }

function galleryIds(payload: WorkingPayload | undefined): string[] {
  const images = (payload as { images?: unknown } | undefined)?.images
  return Array.isArray(images) ? (images as GalleryRow[]).map((r) => r.image_id) : []
}

/** Gallery images the undone payload names that the gallery it replaces
 *  does not, and the pool (when known) does not hold: the files an undo
 *  may have to put back from the Trash. */
export function imagesToFind(
  undone: WorkingPayload,
  current: WorkingPayload | undefined,
  pool: Record<string, unknown> | null
): string[] {
  const shown = new Set(galleryIds(current))
  return galleryIds(undone).filter((id) => !shown.has(id) && !(pool && id in pool))
}

/** The payload with its gallery rows renamed (a file put back under the
 *  id of the same picture already in the pool, or under `local-<sha8>`),
 *  or null when no row names a renamed image. */
export function renameGalleryRows(
  payload: WorkingPayload,
  renames: Map<string, string>
): WorkingPayload | null {
  const images = (payload as { images?: unknown }).images
  if (!Array.isArray(images)) return null
  const rows = images as GalleryRow[]
  if (!rows.some((r) => renames.has(r.image_id))) return null
  return {
    ...payload,
    images: rows.map((r) => {
      const to = renames.get(r.image_id)
      return to ? { ...r, image_id: to } : r
    })
  }
}

function listed(items: string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** "Undo put back sunset.png from the Trash." and what else happened:
 *  null when the step brought back no missing file. */
export function putBackNote(
  step: 'Undo' | 'Redo',
  outcome: { putBack: string[]; leftInTrash: string[]; missing: string[] }
): string | null {
  const parts: string[] = []
  if (outcome.putBack.length) {
    parts.push(`${step} put back ${listed(outcome.putBack)} from the Trash.`)
  }
  if (outcome.leftInTrash.length) {
    const one = outcome.leftInTrash.length === 1
    parts.push(
      `${step} brought back ${one ? 'image' : 'images'} ${listed(outcome.leftInTrash)}, ` +
        `which ${one ? 'stays' : 'stay'} in the Trash: the pool has a different file under that name.`
    )
  }
  if (outcome.missing.length) {
    const one = outcome.missing.length === 1
    parts.push(
      `${step} brought back ${one ? 'image' : 'images'} ${listed(outcome.missing)}, ` +
        `which ${one ? 'is' : 'are'} in neither the pool nor the Trash.`
    )
  }
  return parts.length ? parts.join(' ') : null
}
