import { useEffect, useRef, useState } from 'react'
import { useStore } from '../../state'
import { ChoiceButtons, isKinkChoice, type KinkChoice } from './ChoiceButtons'
import { KinkDescriptionEditor } from './KinkDescriptionEditor'

export function KinkDetailPane({
  characterId,
  kinkId
}: {
  characterId: string
  kinkId: string | null
}) {
  const slot = useStore((s) => s.flistWorking[characterId])
  const live = useStore((s) => s.flistArchive[characterId]?.live ?? null)
  const editField = useStore((s) => s.flistCustomKinksEdit)
  const tombstone = useStore((s) => s.flistCustomKinksTombstone)
  const undelete = useStore((s) => s.flistCustomKinksUndelete)
  const resetField = useStore((s) => s.flistCustomKinksResetField)

  if (!slot || !kinkId) {
    return (
      <div className="kink-detail kink-detail-empty">
        <p>Pick a kink from the rail to edit, or click + Add to create one.</p>
      </div>
    )
  }
  const ck = (slot.payload.custom_kinks as Record<string, Record<string, unknown>>) ?? {}
  const entry = ck[kinkId]
  if (!entry) {
    return (
      <div className="kink-detail kink-detail-empty">
        <p>This kink was removed. Pick another from the rail.</p>
      </div>
    )
  }
  const overlay = new Set(slot.overlay)
  const isLocal = kinkId.startsWith('local:')
  const liveCk =
    (live as { custom_kinks?: Record<string, unknown> } | null)?.custom_kinks ?? {}
  const liveEntry = (liveCk as Record<string, Record<string, unknown>>)[kinkId]
  const isDeleted = entry._deleted === true
  const choice: KinkChoice = isKinkChoice(entry.choice) ? entry.choice : 'undecided'
  const name = typeof entry.name === 'string' ? (entry.name as string) : ''
  const description = typeof entry.description === 'string' ? (entry.description as string) : ''
  const children = Array.isArray(entry.children) ? (entry.children as unknown[]) : []
  const liveName = liveEntry && typeof liveEntry.name === 'string' ? (liveEntry.name as string) : null
  const liveDesc =
    liveEntry && typeof liveEntry.description === 'string'
      ? (liveEntry.description as string)
      : null
  const liveChoice =
    liveEntry && isKinkChoice(liveEntry.choice) ? liveEntry.choice : null

  return (
    <div className="kink-detail" data-testid={`kink-detail-${kinkId}`}>
      {isDeleted && (
        <div className="kink-detail-banner kink-detail-banner-tombstone">
          Tombstoned — will be excluded from the ZIP export.
          <button type="button" onClick={() => undelete(characterId, kinkId)}>
            Restore
          </button>
        </div>
      )}

      <NameField
        characterId={characterId}
        kinkId={kinkId}
        value={name}
        liveValue={liveName}
        overlaid={overlay.has(`custom_kinks.${kinkId}.name`)}
        disabled={isDeleted}
        onCommit={(next) => editField(characterId, kinkId, 'name', next)}
        onReset={() => resetField(characterId, kinkId, 'name')}
      />

      <div className="kink-detail-field">
        <span className="kink-detail-field-label">Choice</span>
        <ChoiceButtons
          value={choice}
          onChange={(next) => editField(characterId, kinkId, 'choice', next)}
          disabled={isDeleted}
        />
        {overlay.has(`custom_kinks.${kinkId}.choice`) && liveChoice && (
          <p className="kink-detail-field-live">
            <button
              type="button"
              className="kink-detail-reset"
              onClick={() => resetField(characterId, kinkId, 'choice')}
              title="Reset choice to F-list value"
            >
              ↺ reset
            </button>
            F-list: {liveChoice}
          </p>
        )}
      </div>

      <div className="kink-detail-field kink-detail-field-description">
        <div className="kink-detail-field-label-row">
          <span className="kink-detail-field-label">Description (BBCode)</span>
          {overlay.has(`custom_kinks.${kinkId}.description`) && (
            <button
              type="button"
              className="kink-detail-reset"
              onClick={() => resetField(characterId, kinkId, 'description')}
              title="Reset description to F-list value"
            >
              ↺ reset
            </button>
          )}
        </div>
        <KinkDescriptionEditor
          kinkId={kinkId}
          value={description}
          onChange={(next) => editField(characterId, kinkId, 'description', next)}
          readOnly={isDeleted}
        />
        {overlay.has(`custom_kinks.${kinkId}.description`) && liveDesc != null && (
          <details className="kink-detail-field-live">
            <summary>F-list: {(liveDesc ?? '').slice(0, 80)}…</summary>
            <pre className="kink-detail-field-live-full">{liveDesc}</pre>
          </details>
        )}
      </div>

      {children.length > 0 && (
        <div className="kink-detail-children">
          <span className="kink-detail-children-label">Linked on F-list</span>
          <p className="kink-detail-children-headline">
            <strong>
              {children.length} linked child kink
              {children.length === 1 ? '' : 's'} — not included in ZIP export.
            </strong>
          </p>
          <p className="kink-detail-children-meta">
            Re-link these on F-list after importing the ZIP back into your
            profile.
          </p>
          <ul className="kink-detail-children-list">
            {children.map((cid) => (
              <li key={String(cid)} className="kink-detail-children-item">
                <ResolvedKinkLabel id={String(cid)} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {!isDeleted && (
        <div className="kink-detail-danger">
          <button
            type="button"
            className="kink-detail-delete"
            onClick={() => tombstone(characterId, kinkId)}
            data-testid="kink-detail-delete"
          >
            {isLocal ? 'Remove' : 'Mark for deletion (won\'t be in ZIP)'}
          </button>
        </div>
      )}
    </div>
  )
}

function NameField({
  characterId: _characterId,
  kinkId,
  value,
  liveValue,
  overlaid,
  disabled,
  onCommit,
  onReset
}: {
  characterId: string
  kinkId: string
  value: string
  liveValue: string | null
  overlaid: boolean
  disabled: boolean
  onCommit: (next: string) => void
  onReset: () => void
}) {
  const [local, setLocal] = useState(value)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    setLocal(value)
  }, [value, kinkId])
  // Debounced commit on change so a Cmd-Q / character-switch mid-type
  // doesn't strand the edit on blur-only commit (UX P2-3 / QA P3-3).
  const scheduleCommit = (next: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      if (next !== value) onCommit(next)
      debounceRef.current = null
    }, 500)
  }
  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    },
    []
  )
  return (
    <div className="kink-detail-field">
      <div className="kink-detail-field-label-row">
        <span className="kink-detail-field-label">Name</span>
        {overlaid && (
          <button
            type="button"
            className="kink-detail-reset"
            onClick={onReset}
            title="Reset name to F-list value"
          >
            ↺ reset
          </button>
        )}
      </div>
      <input
        type="text"
        className="kink-detail-field-input"
        value={local}
        disabled={disabled}
        onChange={(e) => {
          setLocal(e.target.value)
          scheduleCommit(e.target.value)
        }}
        onBlur={() => {
          if (debounceRef.current) {
            clearTimeout(debounceRef.current)
            debounceRef.current = null
          }
          if (local !== value) onCommit(local)
        }}
        placeholder="Kink name"
      />
      {overlaid && (
        <p className="kink-detail-field-live">F-list: {liveValue ?? '—'}</p>
      )}
    </div>
  )
}

function ResolvedKinkLabel({ id }: { id: string }) {
  const mapping = useStore((s) => s.flistMapping.payload)
  const mappingStatus = useStore((s) => s.flistMapping.status)
  if (mappingStatus === 'loading') {
    return <span className="kink-detail-children-loading">Loading kink names…</span>
  }
  const label = (() => {
    if (!mapping) return `kink#${id}`
    const raw = mapping.kinks
    if (!Array.isArray(raw)) return `kink#${id}`
    for (const entry of raw as unknown[]) {
      if (entry && typeof entry === 'object') {
        const e = entry as { id?: unknown; name?: unknown }
        if (String(e.id) === id) {
          return typeof e.name === 'string' ? (e.name as string) : `kink#${id}`
        }
      }
    }
    return `kink#${id}`
  })()
  return <span>{label}</span>
}
