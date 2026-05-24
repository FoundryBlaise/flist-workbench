import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../../state'
import { displayPartner } from '../../lib/partnerName'
import type { PartnerEntry } from '../../lib/api'

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}kb`
  return `${(n / 1024 / 1024).toFixed(1)}mb`
}

const SEARCH_THRESHOLD = 20

export function PartnerList() {
  const activeChar = useStore((s) => s.activeCharacter)
  const partners = useStore((s) => (activeChar ? s.partners[activeChar] : null))
  const status = useStore((s) => (activeChar ? s.partnersStatus[activeChar] : null))
  const loadPartners = useStore((s) => s.loadPartners)
  const activePartner = useStore((s) => s.activePartner)
  const selectPartner = useStore((s) => s.selectPartner)
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (activeChar && status === undefined) void loadPartners(activeChar)
  }, [activeChar, status, loadPartners])

  useEffect(() => {
    setQuery('')
  }, [activeChar])

  const { channels, people } = useMemo(() => {
    const ch: PartnerEntry[] = []
    const pp: PartnerEntry[] = []
    for (const p of partners ?? []) {
      if (p.name.startsWith('#')) ch.push(p)
      else pp.push(p)
    }
    ch.sort((a, b) => b.bytes - a.bytes)
    pp.sort((a, b) => a.name.localeCompare(b.name))
    return { channels: ch, people: pp }
  }, [partners])

  const filteredChannels = useMemo(() => filter(channels, query), [channels, query])
  const filteredPeople = useMemo(() => filter(people, query), [people, query])

  if (!activeChar) return <div className="sb-empty">Pick a character to see partners.</div>
  if (status === 'loading') return <div className="sb-empty">Loading partners…</div>
  if (status === 'error') return <div className="sb-empty">Couldn't load partners.</div>
  if (!partners) return null
  if (partners.length === 0) return <div className="sb-empty">No partners yet for {activeChar}.</div>

  const showSearch = partners.length > SEARCH_THRESHOLD

  return (
    <div className="sb-partner-wrap">
      {showSearch && (
        <input
          type="search"
          className="sb-partner-search"
          placeholder="Filter partners…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter partners"
          data-testid="partner-search"
        />
      )}
      {channels.length > 0 && (
        <PartnerSection
          heading="Channels"
          entries={filteredChannels}
          totalCount={channels.length}
          query={query}
          activePartner={activePartner}
          onSelect={selectPartner}
          testid="partner-list-channels"
        />
      )}
      {people.length > 0 && (
        <PartnerSection
          heading="Partners"
          entries={filteredPeople}
          totalCount={people.length}
          query={query}
          activePartner={activePartner}
          onSelect={selectPartner}
          testid="partner-list-people"
        />
      )}
    </div>
  )
}

function filter(entries: PartnerEntry[], query: string): PartnerEntry[] {
  if (!query.trim()) return entries
  const q = query.toLowerCase()
  return entries.filter((e) => e.name.toLowerCase().includes(q))
}

function PartnerSection({
  heading,
  entries,
  totalCount,
  query,
  activePartner,
  onSelect,
  testid
}: {
  heading: string
  entries: PartnerEntry[]
  totalCount: number
  query: string
  activePartner: string | null
  onSelect: (name: string) => void
  testid: string
}) {
  return (
    <div className="sb-subsection">
      <div className="sb-subsection-h">
        {heading} <span className="sb-subsection-count">({totalCount.toLocaleString()})</span>
      </div>
      {entries.length === 0 ? (
        <div className="sb-empty-inline">
          {query ? `No ${heading.toLowerCase()} match "${query}".` : `No ${heading.toLowerCase()}.`}
        </div>
      ) : (
        <ul className="sb-list sb-list-inline" data-testid={testid}>
          {entries.map((p) => {
            const isChannel = p.name.startsWith('#')
            return (
              <li key={p.name}>
                <button
                  type="button"
                  className={`sb-item ${p.name === activePartner ? 'active' : ''}`}
                  onClick={() => onSelect(p.name)}
                  title={p.name}
                >
                  <span className="ic" aria-hidden>
                    {isChannel ? '#' : '•'}
                  </span>
                  <span className="label">{displayPartner(p.name)}</span>
                  <span className="meta">{formatBytes(p.bytes)}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
