import { useEffect } from 'react'
import { useStore } from '../../state'

function formatRemaining(secs: number | undefined): string {
  if (!secs || secs <= 0) return '0m'
  const m = Math.floor(secs / 60)
  if (m >= 60) return `${Math.floor(m / 60)}h`
  if (m > 0) return `${m}m`
  return `${secs}s`
}

export function SessionFooterChip() {
  const session = useStore((s) => s.flistSession)
  const refresh = useStore((s) => s.flistRefreshSession)

  useEffect(() => {
    void refresh()
    const id = window.setInterval(refresh, 60_000)
    return () => window.clearInterval(id)
  }, [refresh])

  if (!session.active) return null
  const remaining = formatRemaining(session.expires_in_sec)
  const refreshing = session.needs_refresh ? ' refreshing…' : ''
  return (
    <span
      className="flist-session-chip"
      title={`F-list session — ${remaining} left${refreshing}`}
      data-testid="flist-session-chip"
    >
      🔓 {remaining} left{refreshing}
    </span>
  )
}
