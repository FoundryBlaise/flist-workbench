import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type PartnerEntry } from '../../lib/api'
import { displayPartner } from '../../lib/partnerName'

export type AliasLinkDialogProps = {
  character: string
  // The partner the user right-clicked to "Link to another name". Its
  // existing group members are excluded from the picker.
  partner: PartnerEntry
  // The full partner list (already loaded) so the picker can filter
  // locally without a refetch.
  allPartners: PartnerEntry[]
  onClose: () => void
  // Receives the names that ended up in the alias group after the
  // link succeeded. Caller uses this to invalidate cached log streams
  // and refresh the partner list.
  onLinked: (groupNames: string[]) => void
}

export function AliasLinkDialog({
  character,
  partner,
  allPartners,
  onClose,
  onLinked
}: AliasLinkDialogProps) {
  const [filter, setFilter] = useState('')
  const [status, setStatus] = useState<'idle' | 'linking' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // ESC dismisses. Backdrop click is intentionally inert across all
  // modals in the app — accidentally clicking outside used to drop
  // mid-task state (Settings, mid-job dialogs); explicit close only.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // Exclude the row's own group from candidates — relinking yourself
  // is a no-op and listing it would be confusing.
  const ownGroup = new Set<string>([partner.name, ...partner.aliases])
  const candidates = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return allPartners
      .filter((p) => !ownGroup.has(p.name))
      .filter((p) => !q || p.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allPartners, filter, partner.name, partner.aliases.join('|')])

  const linkTo = async (other: PartnerEntry) => {
    if (status === 'linking') return
    setStatus('linking')
    setError(null)
    try {
      // Convention: keep the right-clicked row as the canonical
      // "primary" — the rest fold into it. User intuition is "I'm
      // calling this group X, also under these other names".
      const result = await api.aliasesAdd({
        character,
        name: other.name,
        primary_name: partner.name
      })
      onLinked(result.group)
      onClose()
    } catch (err) {
      setStatus('error')
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
    >
      <div className="modal classify-modal" data-testid="alias-link-dialog">
        <header className="modal-head">
          <div>
            <h2 className="modal-title">Link another name to this partner</h2>
            <p className="modal-subtitle">
              Keeping <strong>{displayPartner(partner.name)}</strong> as the
              primary name. Linked names get folded into one merged
              conversation.
            </p>
          </div>
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </header>
        <div className="modal-body">
          {partner.aliases.length > 0 && (
            <p className="settings-meta">
              Already linked: {partner.aliases.map(displayPartner).join(', ')}
            </p>
          )}
          <input
            ref={inputRef}
            type="search"
            className="settings-input"
            placeholder="Filter partners…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            data-testid="alias-link-filter"
          />
          {error && <p className="settings-error">{error}</p>}
          {candidates.length === 0 ? (
            <p className="settings-help">
              No other partners under <code>{character}</code> to link to.
            </p>
          ) : (
            <ul className="alias-candidates" data-testid="alias-candidates">
              {candidates.map((p) => (
                <li key={p.name}>
                  <button
                    type="button"
                    className="alias-candidate"
                    onClick={() => void linkTo(p)}
                    disabled={status === 'linking'}
                    data-testid="alias-candidate"
                  >
                    <span className="alias-candidate-name">
                      {displayPartner(p.name)}
                    </span>
                    {p.aliases.length > 0 && (
                      <span className="settings-meta">
                        also: {p.aliases.map(displayPartner).join(', ')}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
