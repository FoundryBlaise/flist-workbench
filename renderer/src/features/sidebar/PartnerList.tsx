import { useEffect } from 'react'
import { useStore } from '../../state'

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}kb`
  return `${(n / 1024 / 1024).toFixed(1)}mb`
}

// F-Chat writes partner directory names lower-cased. Display them
// title-cased so they match the message-row author names; preserve the
// '#' prefix on channels and the original casing of any segment that
// already includes a non-letter (channel ADH hashes, etc).
function displayPartner(name: string): string {
  if (!/[a-z]/.test(name)) return name
  return name.replace(/\b([a-z])([a-z]*)/g, (_m, h: string, t: string) => h.toUpperCase() + t)
}

export function PartnerList() {
  const activeChar = useStore((s) => s.activeCharacter)
  const partners = useStore((s) => (activeChar ? s.partners[activeChar] : null))
  const status = useStore((s) => (activeChar ? s.partnersStatus[activeChar] : null))
  const loadPartners = useStore((s) => s.loadPartners)
  const activePartner = useStore((s) => s.activePartner)
  const selectPartner = useStore((s) => s.selectPartner)

  useEffect(() => {
    if (activeChar && status === undefined) void loadPartners(activeChar)
  }, [activeChar, status, loadPartners])

  if (!activeChar) return <div className="sb-empty">Pick a character to see partners.</div>
  if (status === 'loading') return <div className="sb-empty">Loading partners…</div>
  if (status === 'error') return <div className="sb-empty">Couldn't load partners.</div>
  if (!partners) return null
  if (partners.length === 0) return <div className="sb-empty">No partners yet for {activeChar}.</div>

  return (
    <ul className="sb-list" data-testid="partner-list">
      {partners.map((p) => {
        const isChannel = p.name.startsWith('#')
        return (
          <li key={p.name}>
            <button
              type="button"
              className={`sb-item ${p.name === activePartner ? 'active' : ''}`}
              onClick={() => selectPartner(p.name)}
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
  )
}
