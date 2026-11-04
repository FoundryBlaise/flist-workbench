import { useStore } from '../state'
import { describeOrigin } from './describeOrigin'

/** Something outside this window changed the Workbench the user has
 *  open while the window holds unsaved edits: two versions exist and
 *  one has to win, because the in-memory copy autosaves and would
 *  otherwise overwrite the other writer. The banner asks, and waits.
 *
 *  Without unsaved edits there is nothing to decide; the store takes
 *  the change in by itself (`flistNoteExternalChange`) and
 *  WorkbenchNote says who made it.
 */
export function ExternalChangeBanner() {
  const characterId = useStore((s) => s.flistActiveCharacterId)
  const change = useStore((s) =>
    characterId ? s.flistExternalChange[characterId] : null
  )
  const dirty = useStore((s) =>
    characterId ? !!s.flistWorking[characterId]?.unsavedDirty : false
  )
  const reload = useStore((s) => s.flistReloadAfterExternalChange)
  const overwrite = useStore((s) => s.flistOverwriteAfterExternalChange)
  const dismiss = useStore((s) => s.flistDismissExternalChange)

  if (characterId && change && dirty) {
    const by = describeOrigin(change.origin)
    return (
      <div
        className="external-change-banner"
        role="status"
        data-testid="external-change-banner"
      >
        <span>
          <strong>The Workbench changed outside the editor</strong>
          {by ? ` — ${by}.` : '.'}{' '}
          You have unsaved edits here, so one of the two versions has to
          win.
        </span>
        <button
          type="button"
          className="external-change-reload"
          onClick={() => void reload(characterId)}
          data-testid="external-change-reload"
        >
          Discard mine, take theirs
        </button>
        <button
          type="button"
          className="external-change-keep"
          onClick={() => void overwrite(characterId)}
          data-testid="external-change-keep"
        >
          Keep mine
        </button>
        <button
          type="button"
          className="external-change-dismiss"
          onClick={() => dismiss(characterId)}
          aria-label="Dismiss"
          title="Dismiss — nothing is saved until you choose"
          data-testid="external-change-dismiss"
        >
          ✕
        </button>
      </div>
    )
  }

  return null
}
