import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../../state'
import { api, type LogMessage } from '../../lib/api'
import { displayPartner } from '../../lib/partnerName'

type Hit = LogMessage & { index: number }
type PartnerHits = { partner: string; bytes: number; hits: Hit[]; truncated: boolean }

function formatTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function snippet(text: string, query: string, width = 120): { before: string; match: string; after: string } {
  if (!query) return { before: text.slice(0, width), match: '', after: '' }
  const idx = text.toLowerCase().indexOf(query.toLowerCase())
  if (idx === -1) return { before: text.slice(0, width), match: '', after: '' }
  const start = Math.max(0, idx - Math.floor(width / 2))
  const end = Math.min(text.length, idx + query.length + Math.floor(width / 2))
  return {
    before: (start > 0 ? '…' : '') + text.slice(start, idx),
    match: text.slice(idx, idx + query.length),
    after: text.slice(idx + query.length, end) + (end < text.length ? '…' : '')
  }
}

export function CrossSearch({ onClose }: { onClose: () => void }) {
  const activeChar = useStore((s) => s.activeCharacter)
  const selectPartner = useStore((s) => s.selectPartner)
  const [query, setQuery] = useState('')
  const [submitted, setSubmitted] = useState('')
  const [partners, setPartners] = useState<PartnerHits[] | null>(null)
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!submitted || !activeChar) return
    setStatus('loading')
    setError(null)
    let cancelled = false
    api
      .searchAll(activeChar, submitted)
      .then((res) => {
        if (cancelled) return
        setPartners(res.partners)
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
  }, [activeChar, submitted])

  const { totalHits, anyTruncated } = useMemo(() => {
    if (!partners) return { totalHits: 0, anyTruncated: false }
    let n = 0
    let trunc = false
    for (const p of partners) {
      n += p.hits.length
      if (p.truncated) trunc = true
    }
    return { totalHits: n, anyTruncated: trunc }
  }, [partners])

  if (!activeChar) {
    return (
      <section className="pane" data-testid="cross-search">
        <header className="pane-head">Search all partners</header>
        <div className="pane-body pane-body-placeholder">Pick a character first.</div>
      </section>
    )
  }

  return (
    <section className="pane cross-search-pane" data-testid="cross-search">
      <header className="pane-head log-head">
        <span className="partner">Search across all partners</span>
        <span className="log-meta">{activeChar}</span>
        <button type="button" className="cross-search-close" onClick={onClose} aria-label="Close cross-search">
          ✕
        </button>
      </header>
      <form
        className="log-filters"
        onSubmit={(e) => {
          e.preventDefault()
          setSubmitted(query.trim())
        }}
      >
        <input
          autoFocus
          className="log-search"
          placeholder={`Search every log for "${activeChar}"…`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-testid="cross-search-input"
        />
        <button type="submit" className="log-jump" disabled={!query.trim()}>
          Search
        </button>
      </form>
      <div className="pane-body cross-search-body" data-testid="cross-search-body">
        {status === 'idle' && (
          <div className="pane-body-placeholder">
            Type a phrase and hit search to find it across every partner log for {activeChar}.
          </div>
        )}
        {status === 'loading' && <div className="pane-body-placeholder">Searching…</div>}
        {status === 'error' && (
          <div className="pane-body-placeholder">Couldn't search: {error}</div>
        )}
        {status === 'ready' && partners && (
          <>
            <div className="cross-search-summary">
              {anyTruncated ? `${totalHits.toLocaleString()}+` : totalHits.toLocaleString()} hit
              {totalHits === 1 ? '' : 's'} across{' '}
              {partners.length.toLocaleString()} partner{partners.length === 1 ? '' : 's'} for
              <span className="cross-search-q"> "{submitted}"</span>
              {anyTruncated && (
                <span className="cross-search-truncated-note">
                  {' '}
                  · some partners had more hits than fit in the preview — open them to see all
                </span>
              )}
            </div>
            {partners.length === 0 ? (
              <div className="pane-body-placeholder">No matches.</div>
            ) : (
              <ul className="cross-search-groups">
                {partners.map((p) => (
                  <li key={p.partner} className="cross-search-group">
                    <div className="cross-search-group-head">
                      <button
                        type="button"
                        className="cross-search-partner"
                        onClick={() => {
                          selectPartner(p.partner)
                          onClose()
                        }}
                        title={`Open ${displayPartner(p.partner)}`}
                      >
                        {displayPartner(p.partner)}
                      </button>
                      <span className="cross-search-group-meta">
                        {p.truncated
                          ? `${p.hits.length}+ hits (first ${p.hits.length} shown — open the partner to see the rest)`
                          : `${p.hits.length} hit${p.hits.length === 1 ? '' : 's'}`}
                      </span>
                    </div>
                    <ul className="cross-search-hits">
                      {p.hits.map((h) => {
                        const s = snippet(h.text, submitted)
                        return (
                          <li key={`${p.partner}-${h.ts}-${h.index}`}>
                            <button
                              type="button"
                              className="cross-search-hit"
                              onClick={() => {
                                selectPartner(p.partner)
                                onClose()
                              }}
                              title={`${h.speaker} · ${formatTime(h.ts)}`}
                            >
                              <span className="cross-search-hit-meta">
                                <b>{h.speaker}</b> · {formatTime(h.ts)}
                              </span>
                              <span className="cross-search-hit-snippet">
                                {s.before}
                                {s.match && <mark>{s.match}</mark>}
                                {s.after}
                              </span>
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </section>
  )
}
