import { useEffect, useRef, useState } from 'react'

export interface NameDialogProps {
  title: string
  hint?: string
  initialName: string
  confirmLabel: string
  onCancel: () => void
  onConfirm: (name: string) => void
}

export function NameDialog({
  title,
  hint,
  initialName,
  confirmLabel,
  onCancel,
  onConfirm
}: NameDialogProps) {
  const [name, setName] = useState(initialName)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const id = requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    return () => cancelAnimationFrame(id)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  const trimmed = name.trim()
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!trimmed) return
    onConfirm(trimmed)
  }

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      data-testid="ws-name-dialog"
    >
      <div className="modal ws-name-dialog">
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
        <form className="modal-body ws-name-body" onSubmit={submit}>
          <label className="ws-name-field">
            <span>Name</span>
            <input
              ref={inputRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              spellCheck={false}
              maxLength={80}
              data-testid="ws-name-input"
            />
          </label>
          {hint && <p className="ws-name-hint">{hint}</p>}
          <footer className="modal-foot">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={onCancel}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!trimmed}
              data-testid="ws-name-confirm"
            >
              {confirmLabel}
            </button>
          </footer>
        </form>
      </div>
    </div>
  )
}
