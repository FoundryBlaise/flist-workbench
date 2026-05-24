import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../../state'

// F-Chat stores character directory names lower-cased; show them
// title-cased in the UI so they match the names users see everywhere
// else (the message rows, the doc title in the editor header).
function displayName(s: string): string {
  return s.replace(/\b([a-z])([a-z]*)/g, (_m, h: string, t: string) => h.toUpperCase() + t)
}

export function CharacterPicker() {
  const status = useStore((s) => s.charactersStatus)
  const error = useStore((s) => s.charactersError)
  const characters = useStore((s) => s.characters)
  const active = useStore((s) => s.activeCharacter)
  const select = useStore((s) => s.selectCharacter)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const wrapRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

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
    return characters.filter((c) => c.toLowerCase().includes(q))
  }, [characters, query])

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
                select(visible[0])
                setOpen(false)
              }
            }}
            aria-label="Filter characters"
          />
          <ul>
            {visible.map((name) => (
              <li key={name}>
                <button
                  type="button"
                  className={name === active ? 'active' : ''}
                  onClick={() => {
                    select(name)
                    setOpen(false)
                  }}
                  title={name}
                >
                  {displayName(name)}
                </button>
              </li>
            ))}
            {visible.length === 0 && (
              <li className="char-picker-empty-result">No match for "{query}"</li>
            )}
          </ul>
        </div>
      )}
    </div>
  )
}
