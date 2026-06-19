import { useMemo } from 'react'
import { useStore } from '../../state'
import type { AiDraft, AiDraftEdit } from '../../lib/api'
import { ProposalCard } from './ProposalCard'

/** The collapsible review column inside AssistantPane. Groups edits by
 *  composite_id so a single card represents either one atomic edit or
 *  an N-row composite. Provides per-group + bulk Accept/Reject. */
export function DraftReview({
  characterId,
  draft,
  onDiscard
}: {
  characterId: string
  draft: AiDraft | null
  onDiscard: () => void | Promise<void>
}) {
  const accept = useStore((s) => s.acceptAiAssistantEdits)
  const reject = useStore((s) => s.rejectAiAssistantEdits)

  const groups = useMemo(() => groupByComposite(draft?.edits ?? []), [draft])
  const allIds = useMemo(
    () => (draft?.edits ?? []).filter((e) => e.status === 'pending').map((e) => e.id),
    [draft]
  )

  if (!draft || draft.edits.length === 0) {
    return (
      <aside className="assistant-draft" aria-label="Pending edits">
        <header className="assistant-draft-header">
          <span>Pending edits</span>
          <span className="assistant-draft-count">0</span>
        </header>
        <div className="assistant-draft-empty">
          No proposals yet. Ask the assistant for a change to see edit cards here.
        </div>
      </aside>
    )
  }

  return (
    <aside className="assistant-draft" aria-label="Pending edits">
      <header className="assistant-draft-header">
        <span>Pending edits</span>
        <span className="assistant-draft-count">{draft.edits.length}</span>
      </header>
      <div className="assistant-draft-bulk">
        <button
          type="button"
          className="proposal-accept"
          disabled={allIds.length === 0}
          onClick={() => void accept(characterId, allIds)}
          title="Accept every pending edit at once"
        >
          Accept all
        </button>
        {/* Named "Discard draft" to disambiguate from the composite
            "Reject all" — this nukes the draft file; "Reject all"
            inside a composite only drops that group's edits and
            leaves the draft intact. */}
        <button
          type="button"
          className="proposal-reject"
          onClick={() => void onDiscard()}
          title="Discard the whole draft file"
        >
          Discard draft
        </button>
      </div>
      <ul className="assistant-draft-list">
        {groups.map((group) => (
          <li key={group.id} className="assistant-draft-row">
            <ProposalCard
              edits={group.edits}
              characterId={characterId}
              onAccept={(ids) => void accept(characterId, ids)}
              onReject={(ids) => void reject(characterId, ids)}
            />
          </li>
        ))}
      </ul>
    </aside>
  )
}

function groupByComposite(
  edits: AiDraftEdit[]
): Array<{ id: string; edits: AiDraftEdit[] }> {
  const groups = new Map<string, AiDraftEdit[]>()
  const order: string[] = []
  for (const edit of edits) {
    const key = edit.composite_id ?? edit.id
    let bucket = groups.get(key)
    if (!bucket) {
      bucket = []
      groups.set(key, bucket)
      order.push(key)
    }
    bucket.push(edit)
  }
  return order.map((id) => ({ id, edits: groups.get(id) ?? [] }))
}
