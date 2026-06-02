import { useEffect, useRef, useState } from 'react'
import type { NewSetSeed, SetMeta } from './tier7Types'

export interface NewSetMenuProps {
  sets: SetMeta[]
  hasLive: boolean
  onCreate: (seed: NewSetSeed) => void
}

export function NewSetMenu({ sets, hasLive, onCreate }: NewSetMenuProps) {
  const [open, setOpen] = useState(false)
  const popRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!popRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const pick = (seed: NewSetSeed) => {
    setOpen(false)
    onCreate(seed)
  }

  return (
    <div className="t7-new-set" ref={popRef}>
      <button
        type="button"
        className="t7-new-set-btn"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="t7-new-set-btn"
      >
        + New set ▾
      </button>
      {open && (
        <ul className="t7-new-set-menu" role="menu" data-testid="t7-new-set-menu">
          <li
            className={`t7-new-set-item${hasLive ? '' : ' is-disabled'}`}
            role="menuitem"
            aria-disabled={hasLive ? undefined : true}
            title={hasLive ? 'Seed from the most recent F-list pull' : 'Pull this character first'}
            onClick={() => hasLive && pick({ kind: 'live' })}
          >
            <span className="t7-new-set-item-l">From F-list</span>
            <span className="t7-new-set-item-r">latest live pull</span>
          </li>
          <li
            className="t7-new-set-item"
            role="menuitem"
            onClick={() => pick({ kind: 'empty' })}
          >
            <span className="t7-new-set-item-l">Empty set</span>
            <span className="t7-new-set-item-r">start blank</span>
          </li>
          {sets.length > 0 && <li className="t7-new-set-divider" aria-hidden="true" />}
          {sets.map((s) => (
            <li
              key={s.id}
              className="t7-new-set-item"
              role="menuitem"
              onClick={() => pick({ kind: 'fork', setId: s.id })}
            >
              <span className="t7-new-set-item-l">Fork from {s.name}</span>
              <span className="t7-new-set-item-r">copy</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
