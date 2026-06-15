import { EditorView } from '@codemirror/view'
import { useEffect, useRef, useState, type RefObject } from 'react'

export type ToolbarAction = {
  label: string
  title: string
  /** Optional keyboard shortcut, e.g. "Mod-b". Mod = Cmd on Mac, Ctrl elsewhere. */
  shortcut?: string
  wrap?: { open: string; close: string }
  insert?: string
  /**
   * When set, clicking the button opens an inline popover instead of
   * inserting verbatim. Lets the user pick a colour swatch / fill in a
   * URL rather than editing a placeholder string after the fact.
   */
  popover?: 'color' | 'url'
}

// F-list's twelve named colours, in the order F-Chat shows them in its
// own toolbar swatch grid. Kept in sync with lib/bbcode/autocomplete.ts.
const NAMED_COLORS: { name: string; swatch: string }[] = [
  { name: 'red', swatch: '#e84141' },
  { name: 'orange', swatch: '#e88541' },
  { name: 'yellow', swatch: '#e8d041' },
  { name: 'green', swatch: '#5fc25f' },
  { name: 'cyan', swatch: '#5fc2c2' },
  { name: 'blue', swatch: '#4191e8' },
  { name: 'purple', swatch: '#a44ee8' },
  { name: 'pink', swatch: '#e84ea4' },
  { name: 'black', swatch: '#222' },
  { name: 'brown', swatch: '#8a5a3b' },
  { name: 'white', swatch: '#eee' },
  { name: 'gray', swatch: '#888' }
]

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
  { label: 'color', title: 'Colour — pick a named swatch', popover: 'color' },
  { label: 'icon', title: 'Character icon', wrap: { open: '[icon]', close: '[/icon]' } },
  { label: 'eicon', title: 'Emote icon', wrap: { open: '[eicon]', close: '[/eicon]' } },
  { label: 'url', title: 'URL — pick a target', shortcut: 'Mod-k', popover: 'url' },
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
  // popover-typed actions are handled by their popover components; the
  // toolbar router skips applyAction for them. Guard here too in case a
  // caller dispatches one directly.
  if (action.popover) return
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

// Insert an arbitrary open/close wrap around the current selection.
// Shared by the colour swatch and URL popovers.
function wrapSelection(view: EditorView, open: string, close: string) {
  view.dispatch(
    view.state.changeByRange((range) => {
      const selected = view.state.doc.sliceString(range.from, range.to)
      const insert = open + selected + close
      return {
        changes: { from: range.from, to: range.to, insert },
        range: {
          ...range,
          anchor: range.from + open.length,
          head: range.from + open.length + selected.length
        }
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
  const [popoverOpen, setPopoverOpen] = useState(false)
  const wrapRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!popoverOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPopoverOpen(false)
    }
    const onPointer = (e: PointerEvent) => {
      const w = wrapRef.current
      if (w && e.target instanceof Node && !w.contains(e.target)) {
        setPopoverOpen(false)
      }
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointer)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointer)
    }
  }, [popoverOpen])

  const handleClick = () => {
    if (action.popover) {
      setPopoverOpen((v) => !v)
      return
    }
    const view = viewRef.current
    if (view) applyAction(view, action)
  }

  return (
    <span className="tool-popover-wrap" ref={wrapRef}>
      <button
        type="button"
        className="tool"
        title={title}
        aria-label={title}
        aria-expanded={action.popover ? popoverOpen : undefined}
        onClick={handleClick}
      >
        {action.label}
      </button>
      {action.popover === 'color' && popoverOpen && (
        <ColorPopover
          onPick={(name) => {
            const view = viewRef.current
            if (view) wrapSelection(view, `[color=${name}]`, '[/color]')
            setPopoverOpen(false)
          }}
        />
      )}
      {action.popover === 'url' && popoverOpen && (
        <UrlPopover
          viewRef={viewRef}
          onClose={() => setPopoverOpen(false)}
        />
      )}
    </span>
  )
}

function ColorPopover({ onPick }: { onPick: (name: string) => void }) {
  return (
    <div className="tool-popover tool-color-popover" role="menu" data-testid="toolbar-color-popover">
      {NAMED_COLORS.map((c) => (
        <button
          key={c.name}
          type="button"
          role="menuitem"
          className="tool-swatch"
          style={{ background: c.swatch }}
          title={c.name}
          aria-label={c.name}
          onClick={() => onPick(c.name)}
          data-testid={`toolbar-color-${c.name}`}
        />
      ))}
    </div>
  )
}

function UrlPopover({
  viewRef,
  onClose
}: {
  viewRef: RefObject<EditorView | null>
  onClose: () => void
}) {
  // Pre-fill the label input with the current selection so wrapping a
  // selected word still feels like a one-step action.
  const initialLabel = (() => {
    const view = viewRef.current
    if (!view) return ''
    const r = view.state.selection.main
    return view.state.doc.sliceString(r.from, r.to)
  })()
  const [href, setHref] = useState('https://')
  const [label, setLabel] = useState(initialLabel)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const apply = () => {
    const view = viewRef.current
    if (!view) return
    const url = href.trim() || 'https://'
    const text = label || url
    // If the current selection equals the label the user just typed
    // we replace it; otherwise we just insert at the cursor with the
    // label as the link text.
    view.dispatch(
      view.state.changeByRange((range) => {
        const insert = `[url=${url}]${text}[/url]`
        return {
          changes: { from: range.from, to: range.to, insert },
          range: { ...range, anchor: range.from + insert.length, head: range.from + insert.length }
        } as never
      })
    )
    view.focus()
    onClose()
  }

  return (
    <div className="tool-popover tool-url-popover" role="dialog" data-testid="toolbar-url-popover">
      <label className="tool-popover-row">
        <span>URL</span>
        <input
          ref={inputRef}
          type="url"
          value={href}
          onChange={(e) => setHref(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              apply()
            }
          }}
          data-testid="toolbar-url-href"
        />
      </label>
      <label className="tool-popover-row">
        <span>Label</span>
        <input
          type="text"
          value={label}
          placeholder="(uses URL)"
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              apply()
            }
          }}
          data-testid="toolbar-url-label"
        />
      </label>
      <div className="tool-popover-actions">
        <button type="button" onClick={onClose} className="tool-popover-cancel">
          Cancel
        </button>
        <button type="button" onClick={apply} className="tool-popover-apply" data-testid="toolbar-url-apply">
          Insert
        </button>
      </div>
    </div>
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
