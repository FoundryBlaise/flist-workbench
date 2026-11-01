import { useEffect, useState } from 'react'
import { useStore } from '../../state'

/** The banner after "Reset to Live" for one character.
 *
 *  Normally a short-lived Undo with a countdown (UX P1-5). When the
 *  Workbench changed since the reset, the store did not apply the undo:
 *  putting the old Workbench back would revert that change. The banner
 *  then asks, and waits; keeping the change is the safe choice. */
export function ResetUndoBanner({ characterId }: { characterId: string }) {
  const resetUndo = useStore((s) =>
    s.flistResetUndo && s.flistResetUndo.characterId === characterId
      ? s.flistResetUndo
      : null
  )
  const undoReset = useStore((s) => s.flistUndoResetWorking)
  const dismiss = useStore((s) => s.flistDismissResetUndo)
  const [countdown, setCountdown] = useState<number | null>(null)
  const conflict = !!resetUndo?.conflict
  const expiresAt = resetUndo?.expiresAt ?? null

  useEffect(() => {
    if (expiresAt == null || conflict) {
      setCountdown(null)
      return
    }
    const update = () => {
      setCountdown(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)))
    }
    update()
    const interval = setInterval(update, 250)
    return () => clearInterval(interval)
  }, [expiresAt, conflict])

  if (!resetUndo) return null

  if (conflict) {
    return (
      <div
        className="profile-fields-banner profile-fields-banner-undo"
        role="alert"
        aria-live="assertive"
        data-testid="profile-fields-reset-undo"
      >
        The Workbench changed since the reset. Undo would put the old
        version back over that change.
        <button type="button" onClick={() => dismiss()}>
          Keep the change
        </button>
        <button type="button" onClick={() => void undoReset({ overwrite: true })}>
          Undo anyway
        </button>
      </div>
    )
  }

  return (
    <div
      className="profile-fields-banner profile-fields-banner-undo"
      role="alert"
      aria-live="assertive"
      data-testid="profile-fields-reset-undo"
    >
      Working copy reset to Live.
      <button type="button" onClick={() => void undoReset()}>
        Undo{countdown != null ? ` (${countdown}s)` : ''}
      </button>
    </div>
  )
}
