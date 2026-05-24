import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { useStore } from '../../state'
import { displayCharacter } from '../../lib/partnerName'

type ContactsResult = Awaited<ReturnType<typeof api.findContacts>>

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}kb`
  return `${(n / 1024 / 1024).toFixed(1)}mb`
}

function formatDate(ts: number): string {
  if (!ts) return ''
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit'
  })
}

export function FindContactsModal({ onClose }: { onClose: () => void }) {
  const setMode = useStore((s) => s.setMode)
  const selectCharacter = useStore((s) => s.selectCharacter)
  const selectPartner = useStore((s) => s.selectPartner)
  const [name, setName] = useState('')
  const [submitted, setSubmitted] = useState<string | null>(null)
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [result, setResult] = useState<ContactsResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    if (submitted === null) return
    if (!submitted) {
      setStatus('idle')
      setResult(null)
      return
    }
    let cancelled = false
    setStatus('loading')
    setError(null)
    api
      .findContacts(submitted)
      .then((res) => {
        if (cancelled) return
        setResult(res)
        setStatus('ready')
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setStatus('error')
      })
    return () => {
      cancelled = true
    }
  }, [submitted])

  const openContact = (character: string, partner: string) => {
    selectCharacter(character)
    selectPartner(partner)
    setMode('logs')
    onClose()
  }

  return (
    <div className="modal-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div className="modal find-contacts-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h2 className="modal-title">Find contacts</h2>
            <p className="modal-subtitle">
              Find which of your characters has a 1:1 DM log with someone.
            </p>
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <form
          className="modal-body find-contacts-form"
          onSubmit={(e) => {
            e.preventDefault()
            setSubmitted(name.trim())
          }}
        >
          <input
            autoFocus
            type="text"
            className="find-contacts-input"
            placeholder="Character name… (e.g. Aiko Kato)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            data-testid="find-contacts-input"
          />
          <button type="submit" className="find-contacts-submit" disabled={!name.trim()}>
            Find
          </button>
        </form>
        <div className="modal-body find-contacts-results" data-testid="find-contacts-results">
          {status === 'idle' && (
            <p className="find-contacts-placeholder">
              Type a character name and hit Find. We'll look across every one of your
              characters' DM logs for that name.
            </p>
          )}
          {status === 'loading' && (
            <p className="find-contacts-placeholder">Searching…</p>
          )}
          {status === 'error' && (
            <p className="find-contacts-placeholder error">Couldn't search: {error}</p>
          )}
          {status === 'ready' && result && (
            <ContactsTable result={result} submitted={submitted ?? ''} openContact={openContact} />
          )}
        </div>
      </div>
    </div>
  )
}

function ContactsTable({
  result,
  submitted,
  openContact
}: {
  result: ContactsResult
  submitted: string
  openContact: (character: string, partner: string) => void
}) {
  if (result.dm.length === 0) {
    return (
      <p className="find-contacts-placeholder">
        None of your characters has a DM log with <b>{submitted}</b>.
      </p>
    )
  }
  return (
    <>
      <p className="find-contacts-summary">
        <b>{result.dm.length}</b> of your character{result.dm.length === 1 ? ' has' : 's have'} a
        DM log with <b>{displayCharacter(result.name)}</b>.
      </p>
      <table className="find-contacts-table">
        <thead>
          <tr>
            <th>Your character</th>
            <th>Last activity</th>
            <th>Size</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {result.dm.map((d) => (
            <tr key={`${d.character}|${d.partner}`}>
              <td>{displayCharacter(d.character)}</td>
              <td className="meta">{formatDate(d.mtime)}</td>
              <td className="meta">{formatBytes(d.bytes)}</td>
              <td>
                <button
                  type="button"
                  className="find-contacts-open"
                  onClick={() => openContact(d.character, d.partner)}
                >
                  Open
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}
