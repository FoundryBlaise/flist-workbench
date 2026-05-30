import { useEffect, useState } from 'react'
import { useStore } from '../../state'

export function TombstoneUndoBanner({ characterId }: { characterId: string }) {
  const undo = useStore((s) => s.flistTombstoneUndo)
  const undoAction = useStore((s) => s.flistUndoTombstone)
  const [remaining, setRemaining] = useState<number | null>(null)
  useEffect(() => {
    if (!undo || undo.characterId !== characterId) {
      setRemaining(null)
      return
    }
    const update = () =>
      setRemaining(Math.max(0, Math.ceil((undo.expiresAt - Date.now()) / 1000)))
    update()
    const interval = setInterval(update, 250)
    return () => clearInterval(interval)
  }, [undo, characterId])
  if (!undo || undo.characterId !== characterId) return null
  const n = undo.kinkIds.length
  return (
    <div
      className="kink-tombstone-undo-banner"
      role="alert"
      aria-live="assertive"
      data-testid="kink-tombstone-undo"
    >
      <span>
        Marked {n} kink{n === 1 ? '' : 's'} for deletion.
      </span>
      <button type="button" onClick={() => undoAction()}>
        Undo{remaining != null ? ` (${remaining}s)` : ''}
      </button>
    </div>
  )
}
