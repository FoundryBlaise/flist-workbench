import { useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/api'
import { selectWorkingSlot, useStore } from '../../state'

type GalleryRow = {
  image_id: string
  description: string
  sort_order: number
}

// Shared with ImagesTab. Drop is accepted by any gallery item rendering
// in either view, so reordering on one side reflects on the other via
// working.json's `images` array.
const DRAG_MIME_GALLERY_REORDER = 'application/x-flist-gallery-reorder'

function reorderGallery(
  list: GalleryRow[],
  movedId: string,
  targetId: string
): GalleryRow[] {
  if (movedId === targetId) return list
  const from = list.findIndex((e) => e.image_id === movedId)
  const to = list.findIndex((e) => e.image_id === targetId)
  if (from < 0 || to < 0) return list
  const next = list.slice()
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next.map((e, i) => ({ ...e, sort_order: i }))
}

function readGallery(payload: unknown): GalleryRow[] {
  if (!payload || typeof payload !== 'object') return []
  const raw = (payload as { images?: unknown }).images
  if (!Array.isArray(raw)) return []
  const out: GalleryRow[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as {
      image_id?: unknown
      description?: unknown
      sort_order?: unknown
    }
    if (typeof e.image_id !== 'string') continue
    const sort =
      typeof e.sort_order === 'number'
        ? e.sort_order
        : typeof e.sort_order === 'string'
          ? Number(e.sort_order)
          : out.length
    out.push({
      image_id: e.image_id,
      description: typeof e.description === 'string' ? e.description : '',
      sort_order: Number.isFinite(sort) ? (sort as number) : out.length
    })
  }
  out.sort((a, b) => a.sort_order - b.sort_order)
  return out
}

/**
 * Right-pane gallery preview shown when the Images tab is active.
 * Mirrors F-list's profile-page Images section:
 *
 *   - Tile heap: every thumbnail rendered at a fixed display height,
 *     width derived from the image's natural aspect ratio (no cropping).
 *     Flex-wraps into rows so portrait + landscape images coexist
 *     naturally.
 *   - Click a tile → fullscreen overlay with the image centered, back
 *     button top-left, caption underneath, ESC / arrow-keys / click-
 *     outside-image to navigate or dismiss.
 */
export function GalleryPreviewPane() {
  const characterId = useStore((s) => s.flistActiveCharacterId)
  const slot = useStore((s) =>
    characterId ? selectWorkingSlot(s, characterId) ?? null : null
  )
  const setGallery = useStore((s) => s.flistSetGalleryImages)
  const gallery = useMemo(
    () => (slot ? readGallery(slot.payload) : []),
    [slot]
  )
  // Reorder is only meaningful when there's an editable working slot
  // backing the gallery. Without one, the tile heap stays read-only.
  const reorderEnabled = Boolean(characterId && slot)
  const [fullscreenIndex, setFullscreenIndex] = useState<number | null>(null)

  // Keyboard nav while fullscreen is open. ESC closes, ←/→ paginate.
  useEffect(() => {
    if (fullscreenIndex === null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setFullscreenIndex(null)
      } else if (e.key === 'ArrowRight') {
        setFullscreenIndex((i) =>
          i === null ? null : Math.min(gallery.length - 1, i + 1)
        )
      } else if (e.key === 'ArrowLeft') {
        setFullscreenIndex((i) =>
          i === null ? null : Math.max(0, i - 1)
        )
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fullscreenIndex, gallery.length])

  if (!characterId) {
    return (
      <div className="flist-gallery-preview flist-gallery-preview--empty">
        Open a character to preview its gallery.
      </div>
    )
  }
  if (!gallery.length) {
    return (
      <div className="flist-gallery-preview flist-gallery-preview--empty">
        No images in this gallery yet. Add some from the pool on the left
        to see how the profile would render.
      </div>
    )
  }

  return (
    <>
      <div className="flist-gallery-preview" data-testid="flist-gallery-preview">
        <div className="flist-gallery-preview__heading">Images</div>
        <ul className="flist-gallery-preview__heap">
          {gallery.map((row, i) => (
            <li
              key={row.image_id}
              className="flist-gallery-preview__tile"
              draggable={reorderEnabled}
              onDragStart={(e) => {
                if (!reorderEnabled) return
                e.dataTransfer.setData(
                  DRAG_MIME_GALLERY_REORDER,
                  row.image_id
                )
                e.dataTransfer.effectAllowed = 'move'
              }}
              onDragOver={(e) => {
                if (!reorderEnabled) return
                if (!e.dataTransfer.types.includes(DRAG_MIME_GALLERY_REORDER)) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
              }}
              onDrop={(e) => {
                if (!reorderEnabled || !characterId) return
                const movedId = e.dataTransfer.getData(DRAG_MIME_GALLERY_REORDER)
                if (!movedId || movedId === row.image_id) return
                e.preventDefault()
                e.stopPropagation()
                setGallery(
                  characterId,
                  reorderGallery(gallery, movedId, row.image_id)
                )
              }}
            >
              <button
                type="button"
                className="flist-gallery-preview__tile-btn"
                title={row.description || `Image ${i + 1}`}
                onClick={() => setFullscreenIndex(i)}
              >
                <img
                  src={api.flistImageByIdUrl(characterId, row.image_id)}
                  alt={row.description || `Image ${i + 1}`}
                  loading="lazy"
                  draggable={false}
                />
              </button>
            </li>
          ))}
        </ul>
      </div>
      {fullscreenIndex !== null && (
        <FullscreenViewer
          characterId={characterId}
          gallery={gallery}
          index={fullscreenIndex}
          onClose={() => setFullscreenIndex(null)}
          onNavigate={(next) => setFullscreenIndex(next)}
        />
      )}
    </>
  )
}

function FullscreenViewer({
  characterId,
  gallery,
  index,
  onClose,
  onNavigate
}: {
  characterId: string
  gallery: GalleryRow[]
  index: number
  onClose: () => void
  onNavigate: (next: number) => void
}) {
  const active = gallery[index]
  if (!active) return null
  const url = api.flistImageByIdUrl(characterId, active.image_id)
  const hasPrev = index > 0
  const hasNext = index < gallery.length - 1
  return (
    <div
      className="flist-gallery-fullscreen"
      role="dialog"
      aria-modal="true"
      aria-label={active.description || `Image ${index + 1}`}
      data-testid="flist-gallery-fullscreen"
      onClick={(e) => {
        // Click on the backdrop (anything that isn't an action / the
        // image itself) closes. The image + the action buttons stop
        // propagation so they don't dismiss accidentally.
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <header className="flist-gallery-fullscreen__bar">
        <button
          type="button"
          className="flist-gallery-fullscreen__back"
          onClick={onClose}
          data-testid="flist-gallery-fullscreen-back"
        >
          ← Back to gallery
        </button>
        <span className="flist-gallery-fullscreen__counter">
          {index + 1} / {gallery.length}
        </span>
      </header>
      <div className="flist-gallery-fullscreen__stage">
        {hasPrev && (
          <button
            type="button"
            className="flist-gallery-fullscreen__nav flist-gallery-fullscreen__nav--prev"
            onClick={() => onNavigate(index - 1)}
            aria-label="Previous image"
          >
            ‹
          </button>
        )}
        <img
          src={url}
          alt={active.description || `Image ${index + 1}`}
          className="flist-gallery-fullscreen__img"
        />
        {hasNext && (
          <button
            type="button"
            className="flist-gallery-fullscreen__nav flist-gallery-fullscreen__nav--next"
            onClick={() => onNavigate(index + 1)}
            aria-label="Next image"
          >
            ›
          </button>
        )}
      </div>
      {active.description && (
        <div className="flist-gallery-fullscreen__caption">
          {active.description}
        </div>
      )}
    </div>
  )
}
