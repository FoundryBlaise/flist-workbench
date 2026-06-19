import { useMemo, useState } from 'react'
import type { AiDraftEdit } from '../../lib/api'

/** One pending edit, rendered as a Tier-4-style row with Accept/Reject
 *  affordances. Composite edits (multiple atoms sharing a composite_id)
 *  collapse to a single summary card with an expand toggle. */
export function ProposalCard({
  edits,
  characterId,
  onAccept,
  onReject
}: {
  edits: AiDraftEdit[]
  characterId: string
  onAccept: (editIds: string[]) => void
  onReject: (editIds: string[]) => void
}) {
  const isComposite = edits.length > 1 && edits[0].composite_id !== null
  const [expanded, setExpanded] = useState(!isComposite)

  if (isComposite) {
    return (
      <CompositeCard
        edits={edits}
        expanded={expanded}
        onToggleExpand={() => setExpanded((v) => !v)}
        characterId={characterId}
        onAccept={onAccept}
        onReject={onReject}
      />
    )
  }
  return (
    <AtomicCard
      edit={edits[0]}
      characterId={characterId}
      onAccept={() => onAccept([edits[0].id])}
      onReject={() => onReject([edits[0].id])}
    />
  )
}

function AtomicCard({
  edit,
  onAccept,
  onReject
}: {
  edit: AiDraftEdit
  characterId: string
  onAccept: () => void
  onReject: () => void
}) {
  const isStale = edit.status === 'stale'
  return (
    <article
      className={`proposal-card proposal-card-atomic ${
        isStale ? 'proposal-card-stale' : ''
      }`}
      data-testid={`proposal-card-${edit.id}`}
      data-kind={edit.kind}
      data-status={edit.status}
    >
      <header className="proposal-card-header">
        <code className="proposal-card-tool">{edit.tool}</code>
        <span className="proposal-card-path" title={edit.field_path}>
          {edit.field_path}
        </span>
        {isStale && <span className="proposal-card-stale-tag">stale</span>}
      </header>
      <ValueDiff
        oldValue={edit.old_value}
        newValue={edit.new_value}
        oldExcerpt={edit.old_excerpt}
        newLabelHint={edit.new_label_hint}
        kind={edit.kind}
      />
      {edit.rationale && (
        <p className="proposal-card-rationale">{edit.rationale}</p>
      )}
      <footer className="proposal-card-actions">
        <button
          type="button"
          className="proposal-accept"
          onClick={onAccept}
          disabled={isStale}
          title={
            isStale
              ? 'Edit is stale — re-prompt or discard before accepting.'
              : 'Accept this edit (writes to working.json)'
          }
        >
          Accept
        </button>
        <button type="button" className="proposal-reject" onClick={onReject}>
          Reject
        </button>
      </footer>
    </article>
  )
}

function CompositeCard({
  edits,
  expanded,
  onToggleExpand,
  characterId,
  onAccept,
  onReject
}: {
  edits: AiDraftEdit[]
  expanded: boolean
  onToggleExpand: () => void
  characterId: string
  onAccept: (editIds: string[]) => void
  onReject: (editIds: string[]) => void
}) {
  const compositeId = edits[0].composite_id ?? ''
  const summary = useMemo(() => summariseComposite(edits), [edits])
  const allIds = edits.map((e) => e.id)
  const hasStale = edits.some((e) => e.status === 'stale')

  return (
    <article
      className="proposal-card proposal-card-composite"
      data-testid={`proposal-card-${compositeId}`}
      data-composite-id={compositeId}
    >
      <header className="proposal-card-header">
        <code className="proposal-card-tool">{summary.label}</code>
        <span className="proposal-card-meta">{edits.length} edits</span>
        {hasStale && <span className="proposal-card-stale-tag">stale</span>}
        <button
          type="button"
          className="proposal-card-expand"
          onClick={onToggleExpand}
          aria-expanded={expanded}
          aria-label={
            expanded
              ? `Hide the ${edits.length} underlying edits`
              : `Show the ${edits.length} underlying edits`
          }
          title={expanded ? 'Hide details' : `Show all ${edits.length} edits`}
        >
          {expanded ? '▾ Hide' : `▸ Show ${edits.length}`}
        </button>
      </header>
      <p className="proposal-card-summary">{summary.text}</p>
      {expanded && (
        <ul className="proposal-card-children">
          {edits.map((edit) => (
            <li
              key={edit.id}
              className="proposal-card-child"
              data-status={edit.status}
            >
              <code className="proposal-card-tool">{edit.tool}</code>
              <ValueDiff
                oldValue={edit.old_value}
                newValue={edit.new_value}
                oldExcerpt={edit.old_excerpt}
                newLabelHint={edit.new_label_hint}
                kind={edit.kind}
              />
              <button
                type="button"
                className="proposal-reject proposal-reject-small"
                onClick={() => onReject([edit.id])}
                title="Drop this atom; keep the rest of the composite"
              >
                Drop
              </button>
            </li>
          ))}
        </ul>
      )}
      <footer className="proposal-card-actions">
        <button
          type="button"
          className="proposal-accept"
          onClick={() => onAccept(allIds)}
          disabled={hasStale}
        >
          Accept all
        </button>
        <button
          type="button"
          className="proposal-reject"
          onClick={() => onReject(allIds)}
        >
          Reject all
        </button>
      </footer>
    </article>
  )
}

function ValueDiff({
  oldValue,
  newValue,
  oldExcerpt,
  newLabelHint,
  kind
}: {
  oldValue: unknown
  newValue: unknown
  oldExcerpt?: string
  newLabelHint?: string
  kind: AiDraftEdit['kind']
}) {
  if (kind === 'text_patch') {
    return (
      <div className="proposal-card-diff">
        <pre className="proposal-card-old">{String(oldExcerpt ?? '')}</pre>
        <span className="proposal-card-arrow">→</span>
        <pre className="proposal-card-new">{String(newValue ?? '')}</pre>
      </div>
    )
  }
  if (kind === 'text_replace') {
    return (
      <div className="proposal-card-diff">
        <pre className="proposal-card-old">{renderValueTrunc(oldValue)}</pre>
        <span className="proposal-card-arrow">→</span>
        <pre className="proposal-card-new">{renderValueTrunc(newValue)}</pre>
      </div>
    )
  }
  if (kind === 'gallery_reorder') {
    return (
      <div className="proposal-card-diff">
        <span className="proposal-card-meta">Reorder gallery</span>
      </div>
    )
  }
  return (
    <div className="proposal-card-diff proposal-card-diff-inline">
      <code className="proposal-card-old">{renderValueInline(oldValue)}</code>
      <span className="proposal-card-arrow">→</span>
      <code className="proposal-card-new">
        {renderValueInline(newValue)}
        {newLabelHint && newLabelHint !== String(newValue) && (
          <span className="proposal-card-hint"> ({newLabelHint})</span>
        )}
      </code>
    </div>
  )
}

function renderValueInline(value: unknown): string {
  if (value === undefined || value === null) return '—'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') {
    if (value.length === 0) return '(empty)'
    return value.length > 60 ? value.slice(0, 57) + '…' : value
  }
  try {
    const json = JSON.stringify(value)
    return json.length > 60 ? json.slice(0, 57) + '…' : json
  } catch {
    return String(value)
  }
}

function renderValueTrunc(value: unknown): string {
  if (typeof value !== 'string') return renderValueInline(value)
  if (!value) return '(empty)'
  // Show up to ~300 chars in the preview pane; the user can expand the
  // card if they want the full text.
  return value.length > 300 ? value.slice(0, 297) + '…' : value
}

function summariseComposite(edits: AiDraftEdit[]): { label: string; text: string } {
  const tools = new Set(edits.map((e) => e.tool))
  const rationale = edits[0]?.rationale ?? ''
  const label = `composite (${edits.length})`
  if (tools.size === 1) {
    const only = Array.from(tools)[0]
    return {
      label: only,
      text: rationale || `${edits.length} ${only} edits`
    }
  }
  const sampled = Array.from(tools).slice(0, 3).join(', ')
  return {
    label,
    text: rationale || `${edits.length} edits across ${sampled}`
  }
}
