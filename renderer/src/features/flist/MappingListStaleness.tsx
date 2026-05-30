import { useStore } from '../../state'

function relativeDays(unixSec: number | null): { text: string; daysOld: number } {
  if (!unixSec) return { text: 'never refreshed', daysOld: Number.POSITIVE_INFINITY }
  const secs = Math.max(0, Date.now() / 1000 - unixSec)
  const days = Math.floor(secs / (24 * 3600))
  if (days <= 0) {
    const hours = Math.floor(secs / 3600)
    if (hours <= 0) {
      const mins = Math.floor(secs / 60)
      return { text: `${mins} min ago`, daysOld: 0 }
    }
    return { text: `${hours} h ago`, daysOld: 0 }
  }
  return { text: `${days} day${days === 1 ? '' : 's'} ago`, daysOld: days }
}

export function MappingListStaleness({ context }: { context: 'inline' | 'settings' }) {
  const mapping = useStore((s) => s.flistMapping)
  const load = useStore((s) => s.flistLoadMapping)
  const { text, daysOld } = relativeDays(mapping.fetchedAt)
  const stale = daysOld > 7
  const loading = mapping.status === 'loading'
  return (
    <div
      className={`mapping-staleness mapping-staleness-${context}${
        stale ? ' mapping-staleness-stale' : ''
      }`}
      data-testid={`mapping-staleness-${context}`}
      role="status"
    >
      <span className="mapping-staleness-text">
        {loading ? 'refreshing mapping list…' : `mapping list refreshed ${text}`}
      </span>
      <button
        type="button"
        className="mapping-staleness-refresh"
        onClick={() => void load({ force: true })}
        disabled={loading}
        title="Force-refresh the mapping list from F-list"
        aria-busy={loading}
      >
        ↻
      </button>
      {mapping.status === 'error' && mapping.error && (
        <span className="mapping-staleness-error" role="alert">
          {mapping.error}
        </span>
      )}
    </div>
  )
}
