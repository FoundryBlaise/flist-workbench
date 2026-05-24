import { EditorView } from '@codemirror/view'
import { useEffect, useRef, useState, type RefObject } from 'react'

export type ToolbarAction = {
  label: string
  title: string
  /** Optional keyboard shortcut, e.g. "Mod-b". Mod = Cmd on Mac, Ctrl elsewhere. */
  shortcut?: string
  wrap?: { open: string; close: string }
  insert?: string
}

type ToolbarGroup = {
  key: string
  actions: ToolbarAction[]
  /** When true, surfaced behind a "more…" popover instead of the main row. */
  overflow?: boolean
}

// Flat action list, exported so the CodeMirror keymap can pick out the
// ones with shortcuts. Order inside each group is the order rendered.
export const TOOLBAR_ACTIONS: ToolbarAction[] = [
  { label: 'B', title: 'Bold', shortcut: 'Mod-b', wrap: { open: '[b]', close: '[/b]' } },
  { label: 'I', title: 'Italic', shortcut: 'Mod-i', wrap: { open: '[i]', close: '[/i]' } },
  { label: 'U', title: 'Underline', shortcut: 'Mod-u', wrap: { open: '[u]', close: '[/u]' } },
  { label: 'S', title: 'Strikethrough', wrap: { open: '[s]', close: '[/s]' } },
  { label: 'color', title: 'Colour (red)', wrap: { open: '[color=red]', close: '[/color]' } },
  { label: 'icon', title: 'Character icon', wrap: { open: '[icon]', close: '[/icon]' } },
  { label: 'eicon', title: 'Emote icon', wrap: { open: '[eicon]', close: '[/eicon]' } },
  { label: 'url', title: 'URL', shortcut: 'Mod-k', wrap: { open: '[url=https://]', close: '[/url]' } },
  { label: 'spoiler', title: 'Spoiler', wrap: { open: '[spoiler]', close: '[/spoiler]' } },
  {
    label: 'collapse',
    title: 'Collapse',
    wrap: { open: '[collapse=Show]', close: '[/collapse]' }
  },
  { label: 'hr', title: 'Horizontal rule', insert: '[hr]' },
  { label: 'center', title: 'Centre', wrap: { open: '[center]', close: '[/center]' } },
  { label: 'indent', title: 'Indent', wrap: { open: '[indent]', close: '[/indent]' } }
]

// Visual grouping for the toolbar. Order within each group is its
// natural reading order; the overflow group is hidden behind a "more"
// popover to keep the main bar uncluttered.
const TOOLBAR_GROUPS: ToolbarGroup[] = [
  { key: 'format', actions: TOOLBAR_ACTIONS.slice(0, 4) },
  { key: 'colour', actions: TOOLBAR_ACTIONS.slice(4, 5) },
  { key: 'refs', actions: TOOLBAR_ACTIONS.slice(5, 8) },
  { key: 'blocks', actions: TOOLBAR_ACTIONS.slice(8, 10) },
  { key: 'structural', actions: TOOLBAR_ACTIONS.slice(10, 13), overflow: true }
]

// Convert "Mod-b" to a human label that mirrors how F-Chat shows
// shortcuts in its toolbar tooltips.
function shortcutLabel(shortcut: string): string {
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
  return shortcut
    .replace(/Mod/g, isMac ? '⌘' : 'Ctrl')
    .replace(/-/g, isMac ? '' : '+')
    .replace(/\b([a-z])\b/g, (_m, c) => c.toUpperCase())
}

export function applyAction(view: EditorView, action: ToolbarAction) {
  view.dispatch(
    view.state.changeByRange((range) => {
      if (action.insert) {
        return {
          changes: { from: range.from, to: range.to, insert: action.insert },
          range: { ...range, anchor: range.from + action.insert.length, head: range.from + action.insert.length }
        } as never
      }
      const { open, close } = action.wrap!
      const selected = view.state.doc.sliceString(range.from, range.to)
      const insert = open + selected + close
      return {
        changes: { from: range.from, to: range.to, insert },
        range: { ...range, anchor: range.from + open.length, head: range.from + open.length + selected.length }
      } as never
    })
  )
  view.focus()
}

function ToolButton({
  action,
  viewRef
}: {
  action: ToolbarAction
  viewRef: RefObject<EditorView | null>
}) {
  const title = action.shortcut ? `${action.title} (${shortcutLabel(action.shortcut)})` : action.title
  return (
    <button
      type="button"
      className="tool"
      title={title}
      aria-label={title}
      onClick={() => {
        const view = viewRef.current
        if (view) applyAction(view, action)
      }}
    >
      {action.label}
    </button>
  )
}

export function Toolbar({ viewRef }: { viewRef: RefObject<EditorView | null> }) {
  const [moreOpen, setMoreOpen] = useState(false)
  const moreWrapRef = useRef<HTMLDivElement>(null)
  const overflowGroup = TOOLBAR_GROUPS.find((g) => g.overflow)
  const visibleGroups = TOOLBAR_GROUPS.filter((g) => !g.overflow)

  useEffect(() => {
    if (!moreOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMoreOpen(false)
    }
    const onPointer = (e: PointerEvent) => {
      const w = moreWrapRef.current
      if (w && e.target instanceof Node && !w.contains(e.target)) setMoreOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointer)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointer)
    }
  }, [moreOpen])

  return (
    <div className="editor-toolbar" role="toolbar" aria-label="BBCode formatting">
      {visibleGroups.map((group, idx) => (
        <span key={group.key} className="tool-group" data-group={group.key}>
          {group.actions.map((a) => (
            <ToolButton key={a.label} action={a} viewRef={viewRef} />
          ))}
          {idx < visibleGroups.length - 1 && <span className="tool-divider" aria-hidden />}
        </span>
      ))}
      {overflowGroup && (
        <span className="tool-group tool-more-wrap" ref={moreWrapRef}>
          <span className="tool-divider" aria-hidden />
          <button
            type="button"
            className="tool tool-more"
            onClick={() => setMoreOpen((v) => !v)}
            aria-expanded={moreOpen}
            title="More tags"
          >
            more…
          </button>
          {moreOpen && (
            <div className="tool-more-menu" role="menu" data-testid="toolbar-more-menu">
              {overflowGroup.actions.map((a) => (
                <button
                  key={a.label}
                  type="button"
                  role="menuitem"
                  className="tool-more-item"
                  onClick={() => {
                    const view = viewRef.current
                    if (view) applyAction(view, a)
                    setMoreOpen(false)
                  }}
                  title={a.title}
                >
                  <span className="tool-more-tag">[{a.label}]</span>
                  <span className="tool-more-desc">{a.title}</span>
                </button>
              ))}
            </div>
          )}
        </span>
      )}
    </div>
  )
}
