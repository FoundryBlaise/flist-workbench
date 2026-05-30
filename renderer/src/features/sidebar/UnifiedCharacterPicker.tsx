import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../../state'
import { api } from '../../lib/api'
import { displayCharacter as displayName } from '../../lib/partnerName'

function initialFor(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return '?'
  return trimmed.charAt(0).toUpperCase()
}

// Stable colour per-character so the same character always renders the
// same initial-circle when their avatar is missing.
function colourFor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) | 0
  }
  const hue = Math.abs(h) % 360
  return `hsl(${hue} 45% 38%)`
}

function Avatar({
  name,
  size,
  variant = 'avatar'
}: {
  name: string
  size: number
  variant?: 'avatar' | 'archive'
}) {
  const [errored, setErrored] = useState(false)
  // Logs-only characters don't have a live F-list avatar to fetch
  // (and even the deterministic CDN URL would 404 or return a stale
  // image for a deleted character). Render a uniform archive glyph
  // instead — communicates "this character only exists as logs on
  // your machine" without inventing a misleading avatar for them.
  if (variant === 'archive') {
    return (
      <span
        className="char-avatar char-avatar-archive"
        aria-hidden
        style={{ width: size, height: size, fontSize: Math.round(size * 0.6) }}
        title="Logs only — no longer on your F-list account"
      >
        🗄️
      </span>
    )
  }
  if (errored || !name) {
    return (
      <span
        className="char-avatar char-avatar-fallback"
        aria-hidden
        style={{
          width: size,
          height: size,
          background: colourFor(name || '?'),
          fontSize: Math.round(size * 0.5)
        }}
      >
        {initialFor(name)}
      </span>
    )
  }
  return (
    <img
      className="char-avatar"
      src={api.flistAvatarUrl(name)}
      alt=""
      width={size}
      height={size}
      onError={() => setErrored(true)}
    />
  )
}

export function UnifiedCharacterPicker() {
  const session = useStore((s) => s.flistSession)
  const roster = useStore((s) => s.flistRoster)
  const rosterStatus = useStore((s) => s.flistRosterStatus)
  const loadRoster = useStore((s) => s.flistLoadRoster)
  const activeName = useStore((s) => s.activeCharacter)
  const select = useStore((s) => s.selectCharacter)
  const openSignIn = useStore((s) => s.flistOpenSignIn)
  const signOut = useStore((s) => s.flistSignOut)
  const pull = useStore((s) => s.flistPullCharacter)
  const archive = useStore((s) => s.flistArchive)
  const charactersStatus = useStore((s) => s.charactersStatus)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const wrapRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  // Roster aggregates account + archived + log dirs server-side. Pull
  // on mount and whenever the sidecar comes online with logs ready so
  // the picker has data even when the user isn't signed in to F-list.
  useEffect(() => {
    if (rosterStatus === 'idle') void loadRoster()
  }, [rosterStatus, loadRoster])

  // Refresh the roster shortly after the logs roster lands — server-
  // side merge needs both inputs to surface log-only characters.
  useEffect(() => {
    if (charactersStatus === 'ready') void loadRoster()
  }, [charactersStatus, loadRoster])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onPointer = (e: PointerEvent) => {
      const w = wrapRef.current
      if (w && e.target instanceof Node && !w.contains(e.target)) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointer)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointer)
    }
  }, [open])

  useEffect(() => {
    if (open) {
      setQuery('')
      requestAnimationFrame(() => searchRef.current?.focus())
    }
  }, [open])

  const visible = useMemo(() => {
    if (!query.trim()) return roster
    const q = query.toLowerCase()
    return roster.filter((r) => r.name.toLowerCase().includes(q))
  }, [roster, query])

  // Split into the two sources the user mental-models: characters on
  // the F-list account (editor + Pull + everything) vs characters that
  // only exist as F-Chat logs on this machine (Logs-tab only). Account
  // characters come first because the user said API source is primary.
  const accountEntries = useMemo(
    () => visible.filter((r) => r.on_account),
    [visible]
  )
  const logsOnlyEntries = useMemo(
    () => visible.filter((r) => !r.on_account),
    [visible]
  )

  const activeEntry = activeName
    ? roster.find((r) => r.name.toLowerCase() === activeName.toLowerCase()) ?? null
    : null
  const activeDisplay = activeName ? displayName(activeName) : null
  const activeIsLogsOnly = activeEntry !== null && !activeEntry.on_account

  return (
    <div className="char-picker-wrap" data-testid="char-picker" ref={wrapRef}>
      <button
        type="button"
        className="char-picker char-picker-unified"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={activeName ?? undefined}
      >
        <Avatar
          name={activeName ?? ''}
          size={32}
          variant={activeIsLogsOnly ? 'archive' : 'avatar'}
        />
        <span className="info">
          <span className="name">{activeDisplay ?? 'Pick a character'}</span>
          <span className="meta">
            {session.active ? (
              <>
                signed in · {accountEntries.length} on F-list
                {logsOnlyEntries.length > 0 && (
                  <> · {logsOnlyEntries.length} archived</>
                )}
              </>
            ) : (
              <>not signed in · {roster.length} from logs</>
            )}
          </span>
        </span>
        <span className="caret" aria-hidden>
          {open ? '▴' : '▾'}
        </span>
      </button>
      {open && (
        <div className="char-picker-menu char-picker-menu-unified" role="listbox">
          {!session.active && (
            <button
              type="button"
              className="char-picker-signin-cta"
              onClick={() => {
                setOpen(false)
                openSignIn()
              }}
              data-testid="char-picker-signin"
            >
              👤 Sign in to F-list to see your account characters
            </button>
          )}
          <input
            ref={searchRef}
            type="search"
            className="char-picker-search"
            placeholder="Filter…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(false)
            }}
            aria-label="Filter characters"
          />
          {rosterStatus === 'loading' && (
            <div className="char-picker-empty-result">Loading…</div>
          )}
          {visible.length === 0 && rosterStatus !== 'loading' && (
            <div className="char-picker-empty-result">
              {query ? `No match for "${query}"` : 'No characters yet.'}
            </div>
          )}
          <div className="char-picker-scroll">
          {accountEntries.length > 0 && (
            <>
              <div className="char-picker-section-h">On your F-list account</div>
              <ul className="char-picker-unified-list">
                {accountEntries.map((entry) => {
                  const isActive =
                    activeName?.toLowerCase() === entry.name.toLowerCase()
                  const id = entry.id !== null ? String(entry.id) : null
                  const slot = id ? archive[id] : undefined
                  const pullState = slot?.pullStatus ?? 'idle'
                  const pullStage = slot?.pullStage
                  const progress = slot?.pullProgress
                  return (
                    <li
                      key={`acc-${entry.name}-${entry.id ?? 'noid'}`}
                      className={
                        isActive
                          ? 'char-picker-row char-picker-row-active'
                          : 'char-picker-row'
                      }
                    >
                      <button
                        type="button"
                        className="char-picker-row-pick"
                        onClick={() => {
                          void select(entry.name)
                          setOpen(false)
                        }}
                      >
                        <Avatar name={entry.name} size={26} variant="avatar" />
                        <span className="char-picker-row-name">
                          {displayName(entry.name)}
                        </span>
                        {entry.has_archive && (
                          <span
                            className="char-picker-flag"
                            title="Local archive present"
                          >
                            💾
                          </span>
                        )}
                      </button>
                      <button
                        type="button"
                        className="char-picker-pull"
                        onClick={(e) => {
                          e.stopPropagation()
                          void pull(entry.name, id)
                        }}
                        disabled={
                          pullState === 'queued' || pullState === 'running'
                        }
                        title={
                          slot?.lastPullAt
                            ? 'Refresh from F-list'
                            : 'Pull profile from F-list'
                        }
                      >
                        {pullState === 'queued'
                          ? '… queued'
                          : pullState === 'running'
                            ? progress
                              ? `${pullStage ?? '…'} ${progress.done}/${progress.total}`
                              : (pullStage ?? '…')
                            : slot?.lastPullAt
                              ? '↻ Refresh'
                              : '↓ Pull'}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </>
          )}
          {logsOnlyEntries.length > 0 && (
            <>
              <div
                className="char-picker-section-h"
                title="Characters that exist only as F-Chat logs on this machine — not on your current F-list account. Browseable in the Logs tab; cannot be edited or have their profile pulled."
              >
                Logs only ({logsOnlyEntries.length})
              </div>
              <ul className="char-picker-unified-list char-picker-unified-list-archive">
                {logsOnlyEntries.map((entry) => {
                  const isActive =
                    activeName?.toLowerCase() === entry.name.toLowerCase()
                  return (
                    <li
                      key={`log-${entry.name}`}
                      className={
                        isActive
                          ? 'char-picker-row char-picker-row-active'
                          : 'char-picker-row'
                      }
                    >
                      <button
                        type="button"
                        className="char-picker-row-pick"
                        onClick={() => {
                          void select(entry.name)
                          setOpen(false)
                        }}
                      >
                        <Avatar name={entry.name} size={26} variant="archive" />
                        <span className="char-picker-row-name">
                          {displayName(entry.name)}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </>
          )}
          </div>
          {session.active && (
            <div className="char-picker-foot">
              <span className="char-picker-foot-account">
                Signed in as <strong>{session.account}</strong>
              </span>
              <button
                type="button"
                className="char-picker-signout"
                onClick={() => {
                  setOpen(false)
                  void signOut()
                }}
              >
                Sign out
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
