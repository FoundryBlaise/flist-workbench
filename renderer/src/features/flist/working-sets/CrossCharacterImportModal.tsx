import { useEffect } from 'react'

export interface CrossCharacterImportModalProps {
  /** The character the bundle was exported from. */
  source: { characterName: string; setName: string }
  /** The character the bundle is being imported into (currently active). */
  targetCharacterName: string
  onConfirm: () => void
  onCancel: () => void
}

/** Warning modal shown when the user imports a bundle whose source
 *  character differs from the active character. The user can confirm
 *  to copy the source set's profile, kinks, infotags and images into
 *  the active character's archive, or cancel.
 *
 *  Per the project's "no backdrop dismiss" rule the only way out is
 *  the ✕, Cancel, or Escape.
 */
export function CrossCharacterImportModal({
  source,
  targetCharacterName,
  onConfirm,
  onCancel
}: CrossCharacterImportModalProps) {
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
      data-testid="ws-cross-char-import-modal"
    >
      <div className="modal ws-confirm-modal">
        <header className="modal-head">
          <h2 className="modal-title">Import from a different character?</h2>
          <button
            type="button"
            className="modal-close"
            onClick={onCancel}
            aria-label="Close"
          >
            ✕
          </button>
        </header>
        <div className="modal-body ws-confirm-body">
          <p>
            This bundle was exported from{' '}
            <strong>{source.characterName || 'an unknown character'}</strong>
            {source.setName ? <> ({source.setName})</> : null}. You're
            importing it into <strong>{targetCharacterName}</strong>.
          </p>
          <p>
            All profile fields, kinks, infotags and images will be copied
            into a new working set listed under {targetCharacterName}. The
            imported set will be tagged as {targetCharacterName} (the
            source character's identity is dropped).
          </p>
          <p>
            Image bytes whose id already exists in {targetCharacterName}'s
            image store are reused; everything else is written fresh.
          </p>
          <p>Continue?</p>
        </div>
        <footer className="modal-foot">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onCancel}
            data-testid="ws-cross-char-import-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onConfirm}
            data-testid="ws-cross-char-import-confirm"
          >
            Import anyway
          </button>
        </footer>
      </div>
    </div>
  )
}
