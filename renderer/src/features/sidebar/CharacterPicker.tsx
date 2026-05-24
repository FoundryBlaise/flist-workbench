import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../../state'
import { displayCharacter as displayName } from '../../lib/partnerName'

export function CharacterPicker() {
  const status = useStore((s) => s.charactersStatus)
  const error = useStore((s) => s.charactersError)
  const characters = useStore((s) => s.characters)
  const lastSeen = useStore((s) => s.charLastSeen)
  const active = useStore((s) => s.activeCharacter)
  const select = useStore((s) => s.selectCharacter)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const wrapRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  // A character is "recently active" if its log directory has been
  // written since the user last opened it. Unknown last-seen (first
  // launch with already-mtimed dirs) is treated as never-opened: dots
  // light up so the user notices their existing characters.
  const hasNewActivity = (name: string, mtime: number) => {
    if (mtime <= 0) return false
    const seen = lastSeen[name]
    if (seen === undefined) return true
    return mtime > seen
  }

  // Close on Escape, and on any pointer down outside the wrapper. The
  // dropdown otherwise stays open and intercepts clicks on the rest of
  // the UI — a real footgun.
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

  // Focus the search field as soon as the menu opens, and reset the
  // query both on open and on close so reopening doesn't trap the
  // user in a stale filter.
  useEffect(() => {
    if (open) {
      setQuery('')
      requestAnimationFrame(() => searchRef.current?.focus())
    }
  }, [open])

  const visible = useMemo(() => {
    if (!query.trim()) return characters
    const q = query.toLowerCase()
    return characters.filter((c) => c.name.toLowerCase().includes(q))
  }, [characters, query])

  const recentCount = useMemo(
    () => characters.filter((c) => hasNewActivity(c.name, c.mtime)).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [characters, lastSeen]
  )

  if (status === 'loading' || status === 'idle') {
    return (
      <div className="char-picker char-picker-empty" data-testid="char-picker">
        Loading characters…
      </div>
    )
  }
  if (status === 'error') {
    return (
      <div className="char-picker char-picker-empty char-picker-error" data-testid="char-picker">
        Couldn't reach sidecar: {error}
      </div>
    )
  }
  if (characters.length === 0) {
    return (
      <div className="char-picker char-picker-empty" data-testid="char-picker">
        No characters in F-Chat data dir.
      </div>
    )
  }

  return (
    <div className="char-picker-wrap" data-testid="char-picker" ref={wrapRef}>
      <button
        type="button"
        className="char-picker"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={active ?? undefined}
      >
        <span className="avatar" aria-hidden />
        <span className="info">
          <span className="name">{active ? displayName(active) : 'Select character'}</span>
          <span className="meta">
            {characters.length} character{characters.length === 1 ? '' : 's'}
            {recentCount > 0 && (
              <>
                {' '}
                ·{' '}
                <span
                  className="char-picker-new"
                  title={`${recentCount} character${recentCount === 1 ? '' : 's'} with new log activity since you last opened them.`}
                >
                  {recentCount} new
                </span>
              </>
            )}
          </span>
        </span>
        <span className="caret" aria-hidden>
          {open ? '▴' : '▾'}
        </span>
      </button>
      {open && (
        <div className="char-picker-menu" role="listbox">
          <input
            ref={searchRef}
            type="search"
            className="char-picker-search"
            placeholder="Filter characters…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(false)
              if (e.key === 'Enter' && visible.length > 0) {
                select(visible[0].name)
                setOpen(false)
              }
            }}
            aria-label="Filter characters"
          />
          <ul>
            {visible.map((c) => {
              const isNew = hasNewActivity(c.name, c.mtime)
              return (
                <li key={c.name}>
                  <button
                    type="button"
                    className={c.name === active ? 'active' : ''}
                    onClick={() => {
                      select(c.name)
                      setOpen(false)
                    }}
                    title={c.name}
                  >
                    <span
                      className={`char-dot ${isNew ? 'char-dot-new' : ''}`}
                      aria-hidden
                      title={isNew ? 'New log activity since you last opened this character.' : undefined}
                    />
                    {displayName(c.name)}
                  </button>
                </li>
              )
            })}
            {visible.length === 0 && (
              <li className="char-picker-empty-result">No match for "{query}"</li>
            )}
          </ul>
          {active && (
            <ClassifyAllPartnersButton
              character={active}
              onAfter={() => setOpen(false)}
            />
          )}
        </div>
      )}
    </div>
  )
}

function ClassifyAllPartnersButton({
  character,
  onAfter
}: {
  character: string
  onAfter: () => void
}) {
  const openClassify = useStore((s) => s.openClassify)
  return (
    <button
      type="button"
      className="char-picker-classify"
      onClick={() => {
        openClassify({ character }, `All partners for ${displayName(character)}`)
        onAfter()
      }}
      title="Send every unlabeled message across this character's DMs to the LLM for IC/OOC classification."
      data-testid="char-picker-classify"
    >
      Classify all partners for {displayName(character)}…
    </button>
  )
}
