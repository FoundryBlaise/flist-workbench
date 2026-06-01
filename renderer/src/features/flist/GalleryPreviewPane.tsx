import { useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/api'
import { useStore } from '../../state'

type GalleryRow = {
  image_id: string
  description: string
  sort_order: number
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
 * Mirrors F-list's profile-page Images section: big main image with a
 * description, plus a horizontal thumbnail strip the user can click to
 * page through. Keyboard arrows step through too so a curator can
 * sanity-check the order without reaching for the mouse.
 */
export function GalleryPreviewPane() {
  const characterId = useStore((s) => s.flistActiveCharacterId)
  const slot = useStore((s) =>
    characterId ? s.flistWorking[characterId] : null
  )
  const gallery = useMemo(
    () => (slot ? readGallery(slot.payload) : []),
    [slot]
  )
  const [activeIndex, setActiveIndex] = useState(0)

  // Reset selection if the gallery shrinks past our cursor.
  useEffect(() => {
    if (activeIndex >= gallery.length && gallery.length > 0) {
      setActiveIndex(gallery.length - 1)
    }
  }, [activeIndex, gallery.length])

  useEffect(() => {
    if (!gallery.length) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') {
        setActiveIndex((i) => Math.min(gallery.length - 1, i + 1))
      } else if (e.key === 'ArrowLeft') {
        setActiveIndex((i) => Math.max(0, i - 1))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [gallery.length])

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

  const active = gallery[Math.min(activeIndex, gallery.length - 1)]
  const mainUrl = api.flistImageByIdUrl(characterId, active.image_id)

  return (
    <div className="flist-gallery-preview">
      <div className="flist-gallery-preview__main">
        <img
          src={mainUrl}
          alt={active.description || `Image ${activeIndex + 1}`}
          className="flist-gallery-preview__main-img"
        />
      </div>
      {active.description && (
        <div className="flist-gallery-preview__caption">
          {active.description}
        </div>
      )}
      <div className="flist-gallery-preview__strip-wrap">
        <div className="flist-gallery-preview__counter">
          {activeIndex + 1} / {gallery.length}
        </div>
        <ol className="flist-gallery-preview__strip">
          {gallery.map((row, i) => {
            const url = api.flistImageByIdUrl(characterId, row.image_id)
            const isActive = i === activeIndex
            return (
              <li
                key={row.image_id}
                className={`flist-gallery-preview__strip-item${
                  isActive ? ' flist-gallery-preview__strip-item--active' : ''
                }`}
              >
                <button
                  type="button"
                  onClick={() => setActiveIndex(i)}
                  className="flist-gallery-preview__strip-btn"
                  title={row.description || `Image ${i + 1}`}
                >
                  <img src={url} alt="" loading="lazy" />
                </button>
              </li>
            )
          })}
        </ol>
      </div>
    </div>
  )
}
