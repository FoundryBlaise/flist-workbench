/** The editor panel, in its read-only "somebody else's profile" state.
 *
 *  This is the same real estate the character editor uses, not an
 *  overlay, and it borrows the editor's shape: a tab strip across the
 *  top and a split row beneath it. Description puts the BBCode on the
 *  left and the rendered result on the right, exactly as the editor
 *  does for the user's own profile.
 *
 *  What is missing is the point. No toolbar, no CodeMirror, no Diff
 *  tab, no working set. The panes render the payload and nothing
 *  writes.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type ForeignSource } from '../../lib/api'
import { useStore } from '../../state'
import { Tabs, type TabsTab } from '../../components/Tabs'
import { displayCharacter } from '../../lib/partnerName'
import {
  ForeignDescriptionCode,
  ForeignDescriptionPreview,
  ForeignFieldsPane,
  ForeignImagesPane,
  ForeignKinksPane
} from './foreignPanes'
import { ProfileFieldsPreview } from '../flist/ProfileFieldsPreview'

const SOURCES: { id: ForeignSource; label: string; hint: string }[] = [
  {
    id: 'bookmarks',
    label: 'Bookmarks',
    hint: 'Characters you have bookmarked on F-list.'
  },
  {
    id: 'friends',
    label: 'Friends',
    hint: 'Characters on your F-list friends list.'
  },
  {
    id: 'logs',
    label: 'Logs',
    hint: 'Everyone you have a chat log with. Read locally — no F-list call.'
  },
  {
    id: 'name',
    label: 'By name',
    hint: 'Type an exact character name. F-list has no name search, so spelling counts.'
  }
]

/** How many rows the list paints at once. The pool behind it can run
 *  to thousands; painting all of them is what makes a list feel slow,
 *  and nobody scrolls past a few hundred to find a name they could
 *  have typed three letters of. */
const RENDER_LIMIT = 250

function relativeAge(seconds: number | null | undefined): string {
  if (seconds == null) return 'unknown age'
  if (seconds < 90) return 'just now'
  const m = Math.floor(seconds / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export function ForeignWorkspace() {
  const name = useStore((s) => s.foreignName)
  const profile = useStore((s) => s.foreignProfile)
  const status = useStore((s) => s.foreignStatus)
  const error = useStore((s) => s.foreignError)
  const ageSec = useStore((s) => s.foreignAgeSec)
  const stale = useStore((s) => s.foreignStale)
  const refreshError = useStore((s) => s.foreignRefreshError)
  const load = useStore((s) => s.foreignLoad)
  const unload = useStore((s) => s.foreignUnload)

  const mapping = useStore((s) => s.flistMapping.payload)
  const mappingStatus = useStore((s) => s.flistMapping.status)
  const loadMapping = useStore((s) => s.flistLoadMapping)

  const [activeTab, setActiveTab] = useState('description')
  const [avatarFailed, setAvatarFailed] = useState(false)

  // Kink and infotag names come from the mapping list. Usually already
  // cached from the editor, but the Foreign slot can be the first
  // thing a user opens in a session.
  useEffect(() => {
    if (mappingStatus === 'idle') void loadMapping()
  }, [mappingStatus, loadMapping])

  useEffect(() => {
    setAvatarFailed(false)
    setActiveTab('description')
  }, [name])

  const tabs: TabsTab[] = useMemo(() => {
    if (!profile) return []
    const imageCount = Array.isArray(profile.images) ? profile.images.length : 0
    return [
      { id: 'description', label: 'Description (BBCode)', content: null },
      { id: 'fields', label: 'Profile fields', content: null },
      { id: 'kinks', label: 'Kinks', content: null },
      {
        id: 'images',
        label: 'Images',
        badge: imageCount > 0 ? imageCount : undefined,
        content: null
      }
    ]
  }, [profile])

  if (!profile) {
    return (
      <div className="foreign-workspace" data-testid="foreign-workspace">
        <ForeignLookup />
      </div>
    )
  }

  // Description and Profile fields use the editor's two-pane split.
  // Kinks and Images fill the width — they are lists, not documents,
  // and an empty right half would only make the rows narrower.
  const split = activeTab === 'description' || activeTab === 'fields'

  return (
    <div className="foreign-workspace" data-testid="foreign-workspace">
      <div className="foreign-bar">
        {!avatarFailed && name && (
          <img
            className="foreign-avatar"
            src={api.foreignAvatarUrl(name)}
            alt=""
            onError={() => setAvatarFailed(true)}
          />
        )}
        <span className="foreign-bar-name">{displayCharacter(name ?? '')}</span>
        {typeof profile.custom_title === 'string'
          && profile.custom_title.trim() && (
            <span className="foreign-custom-title">{profile.custom_title}</span>
          )}
        <span
          className="foreign-readonly-badge"
          title="Workbench cannot edit, copy, back up or export somebody else's profile."
        >
          read-only
        </span>
        <span className="foreign-spacer" />
        <span
          className={`foreign-age${stale ? ' foreign-age-stale' : ''}`}
          title={
            stale
              ? `Refresh failed: ${refreshError ?? 'unknown error'}`
              : 'Cached locally. Refetched automatically after 24 hours.'
          }
          data-testid="foreign-age"
        >
          {stale ? 'refresh failed — ' : ''}
          {relativeAge(ageSec)}
        </span>
        <button
          type="button"
          className="foreign-btn"
          onClick={() => void load(name ?? '', true)}
          disabled={status === 'loading'}
          data-testid="foreign-refresh"
          title="Fetch this profile from F-list again"
        >
          ↻ Refresh
        </button>
        <button
          type="button"
          className="foreign-btn"
          onClick={unload}
          data-testid="foreign-lookup-another"
        >
          Look up another
        </button>
      </div>
      <Tabs
        tabs={tabs}
        activeId={activeTab}
        onChange={setActiveTab}
        stripOnly
        testId="foreign-tabs"
      />
      {error && (
        <p className="foreign-error" role="alert">
          {error}
        </p>
      )}
      <div
        className="foreign-row"
        data-split={split ? 'split' : 'full'}
        data-testid="foreign-row"
      >
        {activeTab === 'description' && (
          <>
            <ForeignDescriptionCode profile={profile} />
            <ForeignDescriptionPreview profile={profile} />
          </>
        )}
        {activeTab === 'fields' && (
          <>
            <ForeignFieldsPane profile={profile} mapping={mapping} />
            {/* The editor's own Info preview, fed the foreign payload
                rather than a working copy — one implementation for
                both sides instead of two that drift. */}
            <section className="pane preview foreign-pane foreign-pane-info">
              <header className="pane-head">
                Info Preview
                <span className="preview-readonly-hint">· read-only</span>
              </header>
              <div className="pane-body">
                <ProfileFieldsPreview
                  payload={profile as Record<string, unknown>}
                />
              </div>
            </section>
          </>
        )}
        {activeTab === 'kinks' && (
          <ForeignKinksPane profile={profile} mapping={mapping} />
        )}
        {activeTab === 'images' && (
          <ForeignImagesPane profile={profile} characterName={name ?? ''} />
        )}
      </div>
    </div>
  )
}

/** The lookup form, shown when the slot holds nothing yet. */
function ForeignLookup() {
  const load = useStore((s) => s.foreignLoad)
  const status = useStore((s) => s.foreignStatus)
  const error = useStore((s) => s.foreignError)

  const [source, setSource] = useState<ForeignSource>('bookmarks')
  const [query, setQuery] = useState('')
  // The whole candidate pool for the current source, fetched once.
  // Filtering happens here rather than on the sidecar: a round trip
  // per keystroke was costing seconds on the Logs source, and a list
  // of names is something the window can perfectly well search itself.
  const [pool, setPool] = useState<string[]>([])
  const [poolStatus, setPoolStatus] = useState<
    'idle' | 'loading' | 'ready' | 'error'
  >('idle')
  const [poolError, setPoolError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const id = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [])

  // One fetch per source, on switch. The free-text source has no pool:
  // F-list has no character search, so the typed string *is* the
  // answer and asking the server would spend budget to be told so.
  useEffect(() => {
    if (source === 'name') {
      setPool([])
      setPoolStatus('ready')
      setPoolError(null)
      return
    }
    let cancelled = false
    const controller = new AbortController()
    setPoolStatus('loading')
    setPoolError(null)
    api
      .foreignSearch(source, '', { signal: controller.signal })
      .then((res) => {
        if (cancelled) return
        setPool(res.results)
        setPoolStatus('ready')
      })
      .catch((err: unknown) => {
        if (cancelled || controller.signal.aborted) return
        setPoolError(err instanceof Error ? err.message : String(err))
        setPoolStatus('error')
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [source])

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (source === 'name') return q ? [query.trim()] : []
    if (!q) return pool
    return pool.filter((n) => n.toLowerCase().includes(q))
  }, [pool, query, source])

  const shown = matches.slice(0, RENDER_LIMIT)

  return (
    <div className="foreign-lookup" data-testid="foreign-lookup">
      <div className="foreign-lookup-head">
        <h2 className="foreign-lookup-title">Look at another character</h2>
        <p className="foreign-lookup-sub">
          Read-only. Workbench cannot turn somebody else’s profile into a
          working set, a backup or an export — this is for seeing how a
          profile is put together.
        </p>
      </div>
      <div className="foreign-sources" role="tablist" aria-label="Where to look">
        {SOURCES.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={source === entry.id}
            className={`foreign-source${source === entry.id ? ' foreign-source-active' : ''}`}
            onClick={() => setSource(entry.id)}
            title={entry.hint}
            data-testid={`foreign-source-${entry.id}`}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <form
        className="foreign-search-form"
        onSubmit={(e) => {
          e.preventDefault()
          const first = shown[0]
          if (first) void load(first)
        }}
      >
        <input
          ref={inputRef}
          type="text"
          className="foreign-search-input"
          placeholder={
            source === 'name'
              ? 'Exact character name…'
              : 'Filter by name… (leave empty to see everyone)'
          }
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-testid="foreign-search-input"
        />
      </form>
      <p className="foreign-source-hint">
        {SOURCES.find((s) => s.id === source)?.hint}
        {poolStatus === 'ready' && source !== 'name' && pool.length > 0 && (
          <>
            {' · '}
            {matches.length === pool.length
              ? `${pool.length} known`
              : `${matches.length} of ${pool.length}`}
            {matches.length > shown.length && ` · showing first ${shown.length}`}
          </>
        )}
      </p>
      <div className="foreign-results" data-testid="foreign-results">
        {status === 'loading' && (
          <p className="foreign-placeholder">Fetching profile…</p>
        )}
        {status === 'error' && error && (
          <p className="foreign-placeholder error" role="alert">
            {error}
          </p>
        )}
        {poolStatus === 'loading' && (
          <p className="foreign-placeholder">Looking…</p>
        )}
        {poolStatus === 'error' && (
          <p className="foreign-placeholder error">
            Couldn’t load that list: {poolError}
          </p>
        )}
        {poolStatus === 'ready' && shown.length === 0 && (
          <p className="foreign-placeholder">
            {source === 'name'
              ? 'Type a character name.'
              : 'Nothing here matches.'}
          </p>
        )}
        {poolStatus === 'ready' && shown.length > 0 && (
          <ul className="foreign-result-list">
            {shown.map((entry) => (
              <li key={entry}>
                <button
                  type="button"
                  className="foreign-result"
                  onClick={() => void load(entry)}
                  disabled={status === 'loading'}
                >
                  {displayCharacter(entry)}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
