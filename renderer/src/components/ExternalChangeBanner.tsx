import { useEffect, useRef, useState } from 'react'
import { useStore } from '../state'

/** Something outside this window changed the working set the user has
 *  open — in practice, a model editing through MCP.
 *
 *  Two situations, and only one of them is the user's problem.
 *
 *  With unsaved edits in the window, it is a genuine decision: two
 *  versions exist and one has to win, because the in-memory copy
 *  autosaves and would otherwise overwrite the other writer. That is
 *  the banner below, and it waits.
 *
 *  Without unsaved edits there is nothing to decide. The change is
 *  already on disk; asking the user to press "Reload" is asking them
 *  to confirm a foregone conclusion. So the window just reloads and
 *  says what happened — which tool ran, since that is the part they
 *  cannot see for themselves — and the note fades on its own.
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

  const [note, setNote] = useState<string | null>(null)
  const handled = useRef<string | null>(null)

  useEffect(() => {
    if (!characterId || !change || dirty) return
    // Guard against re-entry: reload() clears the change, but the
    // effect can run again before that lands.
    const token = `${characterId}:${change.at}:${change.origin}`
    if (handled.current === token) return
    handled.current = token
    const by = describeOrigin(change.origin)
    setNote(by ? `Updated by ${by}.` : 'Updated outside the editor.')
    void reload(characterId)
  }, [characterId, change, dirty, reload])

  useEffect(() => {
    if (!note) return
    const id = window.setTimeout(() => setNote(null), 8000)
    return () => window.clearTimeout(id)
  }, [note])

  if (characterId && change && dirty) {
    const by = describeOrigin(change.origin)
    return (
      <div
        className="external-change-banner"
        role="status"
        data-testid="external-change-banner"
      >
        <span>
          <strong>This working set changed outside the editor</strong>
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

  if (note) {
    return (
      <div
        className="external-change-note"
        role="status"
        data-testid="external-change-note"
      >
        <span aria-hidden>✓</span> {note}
      </div>
    )
  }

  return null
}

/** "mcp:set_description" reads better as "a model, via
 *  set_description". An unattributed change says nothing. */
function describeOrigin(origin: string): string | null {
  if (!origin || origin === 'ui') return null
  if (origin.startsWith('mcp:')) {
    return `a connected model — ${origin.slice(4)}`
  }
  if (origin === 'mcp') return 'a connected model'
  return null
}
