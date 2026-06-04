import { useEffect, useRef, useState } from 'react'
import { api } from '../../lib/api'

type Pending = {
  handshake_id: string
  fingerprint: string
  created_at: number
}

const POLL_INTERVAL_MS = 2500

export function ExtensionPairWatcher() {
  const [active, setActive] = useState<Pending | null>(null)
  const dismissed = useRef<Set<string>>(new Set())

  useEffect(() => {
    let stopped = false

    const tick = async () => {
      if (stopped) return
      try {
        const res = await api.restorePendingHandshakes()
        const next = (res.pending || []).find(
          (p) => !dismissed.current.has(p.handshake_id)
        )
        if (!stopped) {
          setActive((cur) => {
            if (cur && next && cur.handshake_id === next.handshake_id) return cur
            return next || null
          })
        }
      } catch {
        // sidecar unreachable or transient — just retry next tick
      }
    }

    tick()
    const handle = window.setInterval(tick, POLL_INTERVAL_MS)
    return () => {
      stopped = true
      window.clearInterval(handle)
    }
  }, [])

  if (!active) return null

  return (
    <ExtensionPairModal
      pending={active}
      onClose={() => {
        dismissed.current.add(active.handshake_id)
        setActive(null)
      }}
      onResolved={() => setActive(null)}
    />
  )
}

function ExtensionPairModal({
  pending,
  onClose,
  onResolved
}: {
  pending: Pending
  onClose: () => void
  onResolved: () => void
}) {
  const [busy, setBusy] = useState<'accept' | 'reject' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const accept = async () => {
    setBusy('accept')
    setError(null)
    try {
      const res = await api.restoreAcceptHandshake(pending.handshake_id)
      if (!res.ok) {
        setError(res.error || 'Could not accept the pairing request.')
        setBusy(null)
        return
      }
      onResolved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(null)
    }
  }

  const reject = async () => {
    setBusy('reject')
    setError(null)
    try {
      await api.restoreRejectHandshake(pending.handshake_id)
      onResolved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(null)
    }
  }

  // Memory feedback_no_backdrop_dismiss: backdrop click must not close
  // this modal. Only the ✕ / explicit buttons close it.
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal-shell modal-shell-narrow">
        <header className="modal-header">
          <div>
            <h2 className="modal-title">Browser extension wants to pair</h2>
            <p className="modal-subtitle">
              An F-list Workbench browser extension is asking for permission to
              read your local character backups.
            </p>
          </div>
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            aria-label="Ask again later"
          >
            ✕
          </button>
        </header>
        <div className="modal-body">
          <p>
            If you just clicked <strong>Pair with Workbench</strong> in the
            extension popup, this prompt is expected. Accept it to let the
            extension fetch backup snapshots on{' '}
            <code>character_edit.php</code>.
          </p>
          <p>
            <strong>Extension fingerprint:</strong>{' '}
            <code>{pending.fingerprint}</code>
          </p>
          <p className="settings-help">
            The token grants read-only access to backups + the right to post
            pre-restore snapshots. It does <em>not</em> let the extension
            sign you in, change your F-list account, or pull data from
            F-list itself. Revoke anytime from{' '}
            <strong>Settings → Security</strong>.
          </p>
          {error && (
            <p className="settings-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer className="modal-footer">
          <button
            type="button"
            className="settings-clear"
            onClick={reject}
            disabled={busy !== null}
            data-testid="pair-reject"
          >
            {busy === 'reject' ? 'Rejecting…' : 'Reject'}
          </button>
          <button
            type="button"
            className="settings-save"
            onClick={accept}
            disabled={busy !== null}
            data-testid="pair-accept"
          >
            {busy === 'accept' ? 'Accepting…' : 'Accept'}
          </button>
        </footer>
      </div>
    </div>
  )
}
