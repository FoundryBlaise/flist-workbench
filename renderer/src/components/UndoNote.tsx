import { useCallback } from 'react'
import { useStore } from '../state'
import { FadingNote, useFadeAfter } from './FadingNote'

/** What an undo or redo did about a gallery image whose file was not in
 *  the pool: put back from the Trash, or missing. An undo never brings
 *  such an image back without saying so. The note is the active
 *  character's and fades on its own. */
export function UndoNote() {
  const characterId = useStore((s) => s.flistActiveCharacterId)
  const note = useStore((s) => (characterId ? s.flistUndoNotes[characterId] : undefined))
  const dismiss = useStore((s) => s.flistDismissUndoNote)
  const fade = useCallback(() => {
    if (characterId) dismiss(characterId)
  }, [characterId, dismiss])
  useFadeAfter(characterId ? note : null, fade)

  if (!characterId || !note) return null
  return (
    <FadingNote className="undo-note" testId="undo-note">
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
    </FadingNote>
  )
}
