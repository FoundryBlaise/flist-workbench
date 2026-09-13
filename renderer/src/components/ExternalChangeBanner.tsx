import { useStore } from '../state'

/** Shown when something outside this window changed the working set
 *  the user has open — in practice, a model editing through MCP.
 *
 *  It is a decision, not a notification. The window holds a copy of
 *  the set in memory and autosaves it; if that copy is stale, saving
 *  overwrites the other writer. Until the user picks, autosave keeps
 *  conflicting and nothing is lost either way. */
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

  if (!characterId || !change) return null

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
        {dirty
          ? 'You have unsaved edits here, so one of the two versions has to win.'
          : 'Reload to see it.'}
      </span>
      <button
        type="button"
        className="external-change-reload"
        onClick={() => void reload(characterId)}
        data-testid="external-change-reload"
      >
        {dirty ? 'Discard mine, take theirs' : 'Reload'}
      </button>
      {dirty && (
        <button
          type="button"
          className="external-change-keep"
          onClick={() => void overwrite(characterId)}
          data-testid="external-change-keep"
        >
          Keep mine
        </button>
      )}
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

/** "mcp:set_description" reads better as "a model, via
 *  set_description". An unattributed change says nothing. */
function describeOrigin(origin: string): string | null {
  if (!origin || origin === 'ui') return null
  if (origin.startsWith('mcp:')) {
    return `a connected model ran ${origin.slice(4)}`
  }
  if (origin === 'mcp') return 'a connected model'
  return null
}
