import { useEffect, useRef } from 'react'

const MAX_PREVIEW_THUMBS = 12

/** Confirmation for moving images to the Trash, or deleting Trash
 *  entries for good. Shows what is about to go (thumbnails for images)
 *  and, for the Trash, where those pictures are still used. */
export function ImagesConfirmModal({
  title,
  body,
  notes = [],
  thumbs,
  confirmLabel,
  danger = false,
  onCancel,
  onConfirm
}: {
  title: string
  body: string
  notes?: string[]
  thumbs: { key: string; url: string }[]
  confirmLabel: string
  danger?: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', handler)
    dialogRef.current?.querySelector<HTMLButtonElement>('button[data-autofocus]')?.focus()
    return () => window.removeEventListener('keydown', handler)
  }, [onCancel])

  const shown = thumbs.slice(0, MAX_PREVIEW_THUMBS)
  const more = thumbs.length - shown.length
  return (
    <div
      className="flist-images-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="flist-images-confirm-title"
    >
      <div
        ref={dialogRef}
        className="flist-images-modal flist-images-modal--batch"
        data-testid="flist-images-delete-confirm"
      >
        <h3 id="flist-images-confirm-title" className="flist-images-modal__title">
          {title}
        </h3>
        {thumbs.length > 0 && (
          <div className="flist-images-modal__thumbs">
            {shown.map((t) => (
              <img key={t.key} src={t.url} alt="" loading="lazy" />
            ))}
            {more > 0 && <span className="flist-images-modal__more">+{more} more</span>}
          </div>
        )}
        <p className="flist-images-modal__text">{body}</p>
        {notes.length > 0 && (
          <ul className="flist-images-modal__notes" data-testid="flist-images-usage-notes">
            {notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        )}
        <div className="flist-images-modal__actions">
          <button
            type="button"
            className="flist-images-modal__btn"
            onClick={onCancel}
            data-autofocus
          >
            Cancel
          </button>
          <button
            type="button"
            className={`flist-images-modal__btn${danger ? ' flist-images-modal__btn--danger' : ''}`}
            onClick={onConfirm}
            data-testid="flist-images-delete-confirm-btn"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
