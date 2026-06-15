import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState
} from 'react'

/** Minimal ARIA tablist/tab/tabpanel with arrow-key + Home/End rotation.
 *
 *  `hideStripOnSingle` collapses the strip down to a render-the-only-
 *  panel no-op when there's just one tab. The editor uses it so the
 *  Description tab renders bare until the Profile-fields tab joins. */
export interface TabsTab {
  id: string
  label: ReactNode
  content: ReactNode
  /** Optional badge rendered after the label (e.g. counts). */
  badge?: ReactNode
  /** Disables the tab — focus skips it, click is a no-op. */
  disabled?: boolean
}

export function Tabs({
  tabs,
  activeId,
  onChange,
  hideStripOnSingle = false,
  stripOnly = false,
  stripActions,
  testId
}: {
  tabs: TabsTab[]
  activeId: string
  onChange: (id: string) => void
  hideStripOnSingle?: boolean
  /** Render only the tablist strip (no tabpanel). Used when the tab
   *  content is hosted elsewhere — e.g. the editor where the strip sits
   *  above both editor + preview panes. */
  stripOnly?: boolean
  /** Trailing content rendered to the right of the strip (e.g. a
   *  view-mode toggle for the currently active tab). */
  stripActions?: ReactNode
  testId?: string
}) {
  const generatedId = useId()
  const idPrefix = `tabs-${generatedId.replace(/[:]/g, '_')}`
  const listRef = useRef<HTMLDivElement | null>(null)
  const [focusedId, setFocusedId] = useState<string>(activeId)

  useEffect(() => {
    setFocusedId(activeId)
  }, [activeId])

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const focusable = tabs.filter((t) => !t.disabled)
      if (focusable.length === 0) return
      const idx = focusable.findIndex((t) => t.id === focusedId)
      let nextIdx = idx
      if (event.key === 'ArrowRight') {
        nextIdx = (idx + 1) % focusable.length
      } else if (event.key === 'ArrowLeft') {
        nextIdx = (idx - 1 + focusable.length) % focusable.length
      } else if (event.key === 'Home') {
        nextIdx = 0
      } else if (event.key === 'End') {
        nextIdx = focusable.length - 1
      } else if (event.key === 'Enter' || event.key === ' ') {
        if (focusedId !== activeId) {
          event.preventDefault()
          onChange(focusedId)
        }
        return
      } else {
        return
      }
      event.preventDefault()
      const next = focusable[nextIdx]
      if (next) {
        setFocusedId(next.id)
        const node = listRef.current?.querySelector<HTMLElement>(
          `[data-tab-id="${CSS.escape(next.id)}"]`
        )
        node?.focus()
      }
    },
    [tabs, focusedId, activeId, onChange]
  )

  const active = tabs.find((t) => t.id === activeId) ?? tabs[0]

  if (tabs.length === 0) return null

  const showStrip = !(hideStripOnSingle && tabs.length === 1)

  const strip = showStrip ? (
    <div
      ref={listRef}
      role="tablist"
      aria-orientation="horizontal"
      className="tabs-strip"
      onKeyDown={onKeyDown}
    >
      {tabs.map((tab) => {
        const isActive = tab.id === active?.id
        const tabId = `${idPrefix}-tab-${tab.id}`
        const panelId = `${idPrefix}-panel-${tab.id}`
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={tabId}
            aria-selected={isActive}
            aria-controls={panelId}
            aria-disabled={tab.disabled || undefined}
            tabIndex={isActive ? 0 : -1}
            disabled={tab.disabled}
            data-tab-id={tab.id}
            className={`tabs-tab${isActive ? ' tabs-tab-active' : ''}`}
            onClick={() => {
              if (!tab.disabled && tab.id !== activeId) onChange(tab.id)
            }}
          >
            <span className="tabs-tab-label">{tab.label}</span>
            {tab.badge != null && (
              <span className="tabs-tab-badge">{tab.badge}</span>
            )}
          </button>
        )
      })}
      {stripActions && <div className="tabs-strip-actions">{stripActions}</div>}
    </div>
  ) : null

  if (stripOnly) {
    return (
      <div className="tabs tabs-strip-only" data-testid={testId}>
        {strip}
      </div>
    )
  }

  return (
    <div className="tabs" data-testid={testId}>
      {strip}
      {active && (
        <div
          role="tabpanel"
          id={`${idPrefix}-panel-${active.id}`}
          aria-labelledby={`${idPrefix}-tab-${active.id}`}
          className="tabs-panel"
        >
          {active.content}
        </div>
      )}
    </div>
  )
}
