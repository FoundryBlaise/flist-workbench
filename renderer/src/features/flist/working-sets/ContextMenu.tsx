import { useEffect, useRef } from 'react'

export interface ContextMenuItem {
  label: string
  onSelect: () => void
  disabled?: boolean
  danger?: boolean
  divider?: boolean
}

export interface ContextMenuProps {
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLUListElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown, true)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown, true)
    }
  }, [onClose])

  return (
    <ul
      ref={ref}
      className="ws-ctx-menu"
      role="menu"
      style={{ left: x, top: y }}
      data-testid="ws-ctx-menu"
    >
      {items.map((item, i) =>
        item.divider ? (
          <li key={`div-${i}`} className="ws-ctx-divider" aria-hidden="true" />
        ) : (
          <li
            key={`${item.label}-${i}`}
            className={
              `ws-ctx-item${item.disabled ? ' is-disabled' : ''}` +
              `${item.danger ? ' is-danger' : ''}`
            }
            role="menuitem"
            aria-disabled={item.disabled || undefined}
            onClick={() => {
              if (item.disabled) return
              item.onSelect()
              onClose()
            }}
          >
            {item.label}
          </li>
        )
      )}
    </ul>
  )
}
