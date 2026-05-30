import { useEffect, useRef, useState } from 'react'
import { useStore } from '../../state'
import { api } from '../../lib/api'

function avatarSrc(name: string): string {
  return api.flistAvatarUrl(name)
}

function statusBadge(entry: {
  on_account: boolean
  has_archive: boolean
  has_logs: boolean
}): string {
  const bits: string[] = []
  if (entry.on_account) bits.push('on F-list')
  if (entry.has_archive) bits.push('archived')
  if (entry.has_logs) bits.push('has logs')
  return bits.join(' · ')
}

export function ActiveFlistChip() {
  const session = useStore((s) => s.flistSession)
  const roster = useStore((s) => s.flistRoster)
  const activeId = useStore((s) => s.flistActiveCharacterId)
  const openSignIn = useStore((s) => s.flistOpenSignIn)
  const signOut = useStore((s) => s.flistSignOut)
  const select = useStore((s) => s.flistSelectCharacter)
  const pull = useStore((s) => s.flistPullCharacter)
  const archive = useStore((s) => s.flistArchive)
  const loadRoster = useStore((s) => s.flistLoadRoster)
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (session.active && roster.length === 0) {
      void loadRoster()
    }
  }, [session.active, roster.length, loadRoster])

  // Close the dropdown when the user clicks outside it.
  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!session.active) {
    return (
      <div className="flist-chip-row">
        <button
          type="button"
          className="flist-chip flist-chip-signed-out"
          onClick={openSignIn}
          data-testid="flist-chip-signin"
        >
          <span className="flist-chip-icon">👤</span>
          <span>Sign in to F-list</span>
          <span className="flist-chip-caret">▾</span>
        </button>
      </div>
    )
  }

  const activeEntry = activeId
    ? roster.find((r) => String(r.id ?? '') === activeId) ?? null
    : null

  return (
    <div className="flist-chip-row" ref={containerRef}>
      <button
        type="button"
        className="flist-chip flist-chip-signed-in"
        onClick={() => setOpen((v) => !v)}
        data-testid="flist-chip"
      >
        {activeEntry ? (
          <img
            src={avatarSrc(activeEntry.name)}
            alt=""
            className="flist-chip-avatar"
            onError={(e) => {
              ;(e.currentTarget as HTMLImageElement).style.display = 'none'
            }}
          />
        ) : (
          <span className="flist-chip-icon">👤</span>
        )}
        <span className="flist-chip-name">
          {activeEntry?.name ?? 'Pick a character'}
        </span>
        <span className="flist-chip-caret">▾</span>
      </button>
      {open && (
        <div className="flist-chip-dropdown" role="menu" data-testid="flist-chip-dropdown">
          <div className="flist-chip-account">
            Signed in as <strong>{session.account}</strong>
          </div>
          {roster.length === 0 ? (
            <div className="flist-chip-empty">No characters yet.</div>
          ) : (
            <ul className="flist-chip-list">
              {roster.map((entry) => {
                const id = String(entry.id ?? `name:${entry.name}`)
                const a = archive[id]
                const pullState = a?.pullStatus ?? 'idle'
                const pullStage = a?.pullStage
                const progress = a?.pullProgress
                const isActive = activeId === id
                return (
                  <li
                    key={id}
                    className={`flist-chip-item${isActive ? ' is-active' : ''}`}
                  >
                    <button
                      type="button"
                      className="flist-chip-item-pick"
                      onClick={() => {
                        void select(id)
                        setOpen(false)
                      }}
                      title={statusBadge(entry)}
                    >
                      <img
                        src={avatarSrc(entry.name)}
                        alt=""
                        className="flist-chip-item-avatar"
                        onError={(e) => {
                          ;(e.currentTarget as HTMLImageElement).style.display =
                            'none'
                        }}
                      />
                      <span className="flist-chip-item-name">{entry.name}</span>
                      <span className="flist-chip-item-flags">
                        {entry.on_account && (
                          <span className="flist-chip-flag" title="On your F-list account">
                            👤
                          </span>
                        )}
                        {entry.has_archive && (
                          <span className="flist-chip-flag" title="Local archive">
                            💾
                          </span>
                        )}
                        {entry.has_logs && (
                          <span className="flist-chip-flag" title="Has F-Chat logs">
                            📜
                          </span>
                        )}
                      </span>
                    </button>
                    {entry.on_account && (
                      <button
                        type="button"
                        className="flist-chip-item-pull"
                        onClick={(e) => {
                          e.stopPropagation()
                          void pull(entry.name, entry.id !== null ? String(entry.id) : null)
                        }}
                        disabled={pullState === 'queued' || pullState === 'running'}
                        title="Pull profile from F-list"
                      >
                        {pullState === 'queued'
                          ? 'queued'
                          : pullState === 'running'
                            ? progress
                              ? `${pullStage ?? '…'} ${progress.done}/${progress.total}`
                              : (pullStage ?? '…')
                            : '↓ pull'}
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
          <div className="flist-chip-foot">
            <button
              type="button"
              className="flist-chip-signout"
              onClick={() => {
                setOpen(false)
                void signOut()
              }}
            >
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
