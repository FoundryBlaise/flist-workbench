import { useEffect, useState } from 'react'
import { api, type RagStatus } from '../../lib/api'
import { useStore } from '../../state'

/** "N chunks indexed" for Settings. Read again whenever the sidecar
 *  says the Index changed (`indexRevision`), so an ingest or a wipe a
 *  model runs over MCP shows up without reopening Settings. While a
 *  job holds the Index it says so instead of a count, and an Index
 *  that cannot be read is shown as that, not as empty. */
export function IndexStatus() {
  const revision = useStore((s) => s.indexRevision)
  const [status, setStatus] = useState<RagStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .ragStatus()
      .then((s) => {
        if (cancelled) return
        setStatus(s)
        setError(null)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [revision])

  if (error !== null) {
    return (
      <p className="settings-error" data-testid="rag-index-status">
        {error}
      </p>
    )
  }
  if (status === null) {
    return <p className="settings-meta">Loading status…</p>
  }
  if (status.busy) {
    return (
      <p className="settings-meta" data-testid="rag-index-status">
        The index is being updated ({status.job?.kind ?? 'job'} running). The
        count shows once it has finished.
      </p>
    )
  }
  if (status.chunk_count) {
    return (
      <p className="settings-meta" data-testid="rag-index-status">
        <strong>{status.chunk_count.toLocaleString()}</strong> chunks indexed ·
        model <code>{status.embed_model}</code> (dim {status.embed_dimension})
      </p>
    )
  }
  return (
    <p className="settings-meta" data-testid="rag-index-status">
      No chunks indexed yet. Use{' '}
      <strong>Logs → Ingest All Characters (RAG)…</strong> to build the vector
      index.
    </p>
  )
}
