import { useEffect } from 'react'
import { useStore } from '../state'

const NOTE_MS = 8000

/** What an undo or redo did about a gallery image whose file was not in
 *  the pool: put back from the Trash, or missing. An undo never brings
 *  such an image back without saying so. The note is the active
 *  character's and fades on its own. */
export function UndoNote() {
  const characterId = useStore((s) => s.flistActiveCharacterId)
  const note = useStore((s) => (characterId ? s.flistUndoNotes[characterId] : undefined))
  const dismiss = useStore((s) => s.flistDismissUndoNote)

  useEffect(() => {
    if (!characterId || !note) return
    const id = window.setTimeout(() => dismiss(characterId), NOTE_MS)
    return () => window.clearTimeout(id)
  }, [characterId, note, dismiss])

  if (!characterId || !note) return null
  return (
    <div className="workbench-note undo-note" role="status" data-testid="undo-note">
      <span>{note.text}</span>
      <button
        type="button"
        className="undo-note-dismiss"
        onClick={() => dismiss(characterId)}
        aria-label="Dismiss"
        data-testid="undo-note-dismiss"
      >
        ✕
      </button>
    </div>
  )
}
