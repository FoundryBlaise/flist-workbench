import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../../state'
import { api } from '../../lib/api'
import { displayCharacter as displayName } from '../../lib/partnerName'

function initialFor(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return '?'
  return trimmed.charAt(0).toUpperCase()
}

// 30 min — anything older we treat as stale and auto-pull on select.
const STALE_AGE_SEC = 30 * 60

function relativeAge(epoch: number | null | undefined): string {
  if (epoch === null || epoch === undefined) return 'Never'
  const seconds = Math.max(0, Date.now() / 1000 - epoch)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  const weeks = Math.floor(days / 7)
  if (weeks < 5) return `${weeks}w ago`
  return new Date(epoch * 1000).toLocaleDateString()
}

function isStale(epoch: number | null | undefined): boolean {
  if (epoch === null || epoch === undefined) return true
  return Date.now() / 1000 - epoch >= STALE_AGE_SEC
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
  //
  // SVG instead of the 🗄️ emoji because Windows / Linux emoji fonts
  // render filing-cabinet glyphs inconsistently at small sizes; the
  // inline SVG scales crisply at any size and follows the dark theme.
  if (variant === 'archive') {
    const inset = Math.max(2, Math.round(size * 0.15))
    return (
      <span
        className="char-avatar char-avatar-archive"
        aria-hidden
        style={{ width: size, height: size }}
        title="Logs only — no longer on your F-list account"
      >
        <svg
          width={size - inset * 2}
          height={size - inset * 2}
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.25"
        >
          <rect x="2" y="2" width="12" height="12" rx="1.5" />
          <line x1="2" y1="6" x2="14" y2="6" />
          <line x1="2" y1="10" x2="14" y2="10" />
          <circle cx="8" cy="4" r="0.5" fill="currentColor" stroke="none" />
          <circle cx="8" cy="8" r="0.5" fill="currentColor" stroke="none" />
          <circle cx="8" cy="12" r="0.5" fill="currentColor" stroke="none" />
        </svg>
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
  const archive = useStore((s) => s.flistArchive)
  const activeCharacterId = useStore((s) => s.flistActiveCharacterId)
  const charactersStatus = useStore((s) => s.charactersStatus)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const wrapRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  // Surface pull progress + completion + failure for the active
  // character regardless of which view is showing — the F-list zone
  // hides itself in logs-only mode, so a long pull would otherwise
  // happen with no visible signal. Tracks the most recent in-flight
  // pull, flashes "✓ Updated" briefly on success, and persists the
  // error message until the next pull clears it.
  const activeSlot = activeCharacterId ? archive[activeCharacterId] : undefined
  const pullStatus = activeSlot?.pullStatus
  const pullStage = activeSlot?.pullStage
  const pullProgress = activeSlot?.pullProgress
  const pullError = activeSlot?.pullError
  const [flashDone, setFlashDone] = useState(false)
  const prevPullStatusRef = useRef<string | undefined>(pullStatus)
  useEffect(() => {
    if (prevPullStatusRef.current === 'running' && pullStatus === 'done') {
      setFlashDone(true)
      const t = setTimeout(() => setFlashDone(false), 3000)
      prevPullStatusRef.current = pullStatus
      return () => clearTimeout(t)
    }
    prevPullStatusRef.current = pullStatus
  }, [pullStatus])

  let pillKind: 'progress' | 'done' | 'error' | null = null
  let pillText = ''
  if (pullStatus === 'queued' || pullStatus === 'running') {
    pillKind = 'progress'
    pillText = pullProgress
      ? `${pullStage ?? 'pulling'} ${pullProgress.done}/${pullProgress.total}`
      : (pullStage ?? 'pulling…')
  } else if (pullError) {
    pillKind = 'error'
    pillText = pullError
  } else if (flashDone) {
    pillKind = 'done'
    pillText = '✓ Updated'
  }

  // Pre-drop warning: when the sidecar's idle watchdog is about to
  // clear the cached password (~2 min away), nudge the user to do
  // something that resets the timer. Clicking "Stay signed in" hits
  // the touchable /flist/characters endpoint via flistLoadRoster.
  const idleRemaining = session.password_idle_seconds_remaining
  const showIdleWarning =
    session.active
    && session.password_cached
    && typeof idleRemaining === 'number'
    && idleRemaining > 0
    && idleRemaining <= 120
  const idleMinutesLabel =
    typeof idleRemaining === 'number'
      ? idleRemaining >= 60
        ? `${Math.ceil(idleRemaining / 60)} min`
        : `${idleRemaining}s`
      : null

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
      {pillKind && (
        <div
          className={`char-picker-pull-pill char-picker-pull-pill-${pillKind}`}
          role={pillKind === 'error' ? 'alert' : 'status'}
          data-testid="char-picker-pull-pill"
          title={pillText}
        >
          {pillText}
        </div>
      )}
      {showIdleWarning && (
        <div
          className="char-picker-idle-warning"
          role="status"
          data-testid="char-picker-idle-warning"
        >
          <span>
            Session will be cleared in {idleMinutesLabel} from inactivity —
            you'll need to sign in again to refresh profiles.
          </span>
          <button
            type="button"
            className="char-picker-idle-stay"
            onClick={() => void loadRoster()}
            data-testid="char-picker-idle-stay"
            title="Refreshes the roster, which counts as activity"
          >
            Stay signed in
          </button>
        </div>
      )}
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
                  // Prefer the live slot's lastPullAt (which updates after
                  // an in-session pull) over the roster's static
                  // last_pulled_at (which only refreshes on
                  // flistLoadRoster). Falls back to the roster value
                  // when the slot is empty.
                  const lastPullAt =
                    slot?.lastPullAt ?? entry.last_pulled_at ?? null
                  const pullState = slot?.pullStatus ?? 'idle'
                  const pullStage = slot?.pullStage
                  const progress = slot?.pullProgress
                  const ageLabel =
                    pullState === 'queued'
                      ? '… queued'
                      : pullState === 'running'
                        ? progress
                          ? `${pullStage ?? '…'} ${progress.done}/${progress.total}`
                          : (pullStage ?? 'refreshing…')
                        : relativeAge(lastPullAt)
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
                        title={
                          lastPullAt
                            ? `Last pulled: ${new Date(lastPullAt * 1000).toLocaleString()}`
                            : 'Never pulled — selecting will fetch profile from F-list'
                        }
                      >
                        <Avatar name={entry.name} size={26} variant="avatar" />
                        <span className="char-picker-row-name">
                          {displayName(entry.name)}
                        </span>
                        <span
                          className={`char-picker-row-age${pullState === 'running' || pullState === 'queued' ? ' is-running' : ''}`}
                        >
                          {ageLabel}
                        </span>
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
