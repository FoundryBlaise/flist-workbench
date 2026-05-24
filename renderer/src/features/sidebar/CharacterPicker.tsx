import { useEffect, useRef, useState } from 'react'
import { useStore } from '../../state'

export function CharacterPicker() {
  const status = useStore((s) => s.charactersStatus)
  const error = useStore((s) => s.charactersError)
  const characters = useStore((s) => s.characters)
  const active = useStore((s) => s.activeCharacter)
  const select = useStore((s) => s.selectCharacter)
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

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
      >
        <span className="avatar" aria-hidden />
        <span className="info">
          <span className="name">{active ?? 'Select character'}</span>
          <span className="meta">
            {characters.length} character{characters.length === 1 ? '' : 's'}
          </span>
        </span>
        <span className="caret" aria-hidden>
          {open ? '▴' : '▾'}
        </span>
      </button>
      {open && (
        <ul className="char-picker-menu" role="listbox">
          {characters.map((name) => (
            <li key={name}>
              <button
                type="button"
                className={name === active ? 'active' : ''}
                onClick={() => {
                  select(name)
                  setOpen(false)
                }}
              >
                {name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
