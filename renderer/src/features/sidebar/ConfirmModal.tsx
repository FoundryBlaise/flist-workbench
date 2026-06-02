import { useEffect } from 'react'

export interface ConfirmModalProps {
  title: string
  body: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmModal({
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  onConfirm,
  onCancel
}: ConfirmModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      data-testid="confirm-modal"
    >
      <div className="modal confirm-modal">
        <header className="modal-head">
          <h2 className="modal-title">{title}</h2>
          <button
            type="button"
            className="modal-close"
            onClick={onCancel}
            aria-label="Close"
          >
            ✕
          </button>
        </header>
        <div className="modal-body confirm-modal-body">
          <p>{body}</p>
        </div>
        <footer className="modal-foot">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onCancel}
            data-testid="confirm-modal-cancel"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`btn${danger ? ' btn-danger' : ' btn-primary'}`}
            onClick={onConfirm}
            data-testid="confirm-modal-confirm"
          >
            {confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  )
}
