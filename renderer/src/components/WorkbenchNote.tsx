import { useState } from 'react'
import { useStore } from '../state'
import { parseOrigin } from '../state/commit'
import { describeOrigin } from './describeOrigin'
import { FadingNote, useFadeAfter } from './FadingNote'

type Note = NonNullable<ReturnType<typeof useStore.getState>['flistWorkbenchNote']>

/** A short note on what just happened to the Workbench on screen without
 *  the user doing it by hand: another writer's change the window took in
 *  because nothing was unsaved, or the change an undo or redo stepped
 *  over. It names the writer, since that is the part the user cannot
 *  see, and fades on its own. */
export function WorkbenchNote() {
  const characterId = useStore((s) => s.flistActiveCharacterId)
  const note = useStore((s) => s.flistWorkbenchNote)
  const [faded, setFaded] = useState<Note | null>(null)
  useFadeAfter(note, setFaded)

  if (!note || note === faded || note.characterId !== characterId) return null
  const text = noteText(note)
  if (!text) return null
  return (
    <FadingNote testId="workbench-note">
      <span aria-hidden>✓</span> {text}
    </FadingNote>
  )
}

function noteText(note: Note): string | null {
  const { action, label } = note
  if (label === 'edit') return null
  if (action === 'updated') {
    // The app's own maintenance passes run after most Pulls; taking
    // one in is not news. Undoing one is.
    if (parseOrigin(label)?.writer === 'internal') return null
    const by = describeOrigin(label)
    return by ? `Updated by ${by}.` : 'Updated outside the editor.'
  }
  const verb = action === 'undo' ? 'Undid' : 'Redid'
  if (label === 'restore') return `${verb} the Restore.`
  if (label === 'reset-to-live') return `${verb} the reset to Live.`
  const by = describeOrigin(label)
  return by ? `${verb} the change by ${by}.` : `${verb} a change made outside the editor.`
}
