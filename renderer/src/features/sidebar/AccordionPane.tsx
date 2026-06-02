import type { ReactNode } from 'react'

export interface AccordionSectionProps {
  id: string
  title: string
  count?: number | null
  expanded: boolean
  disabled?: boolean
  disabledHint?: string
  onToggle: () => void
  headerActions?: ReactNode
  children?: ReactNode
}

export function AccordionSection({
  id,
  title,
  count,
  expanded,
  disabled = false,
  disabledHint,
  onToggle,
  headerActions,
  children
}: AccordionSectionProps) {
  const chevron = disabled ? '▸' : expanded ? '▾' : '▸'
  return (
    <section
      className={
        `accordion-section${expanded ? ' is-open' : ''}` +
        `${disabled ? ' is-disabled' : ''}`
      }
      data-testid={`accordion-section-${id}`}
      data-section-id={id}
    >
      <header className="accordion-section-h">
        <button
          type="button"
          className="accordion-section-toggle"
          onClick={disabled ? undefined : onToggle}
          aria-expanded={expanded}
          aria-disabled={disabled}
          title={disabled ? disabledHint : undefined}
          data-testid={`accordion-section-toggle-${id}`}
        >
          <span className="accordion-section-chev" aria-hidden="true">
            {chevron}
          </span>
          <span className="accordion-section-title">{title}</span>
          {typeof count === 'number' && !disabled && (
            <span className="accordion-section-count">· {count}</span>
          )}
          {disabled && disabledHint && (
            <span className="accordion-section-hint">{disabledHint}</span>
          )}
        </button>
        {!disabled && expanded && headerActions && (
          <div className="accordion-section-actions">{headerActions}</div>
        )}
      </header>
      {!disabled && expanded && (
        <div
          className="accordion-section-body"
          data-testid={`accordion-section-body-${id}`}
        >
          {children}
        </div>
      )}
    </section>
  )
}

export function AccordionPane({ children }: { children: ReactNode }) {
  return (
    <div className="accordion-pane" data-testid="accordion-pane">
      {children}
    </div>
  )
}
