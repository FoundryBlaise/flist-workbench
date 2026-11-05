import { EditorView } from '@codemirror/view'
import { EditorSelection } from '@codemirror/state'
import { useEffect, useRef, useState, type RefObject } from 'react'
import { api } from '../../lib/api'
import { useStore } from '../../state'

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
  popover?: 'color' | 'url' | 'eicon'
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
}

// Flat action list, exported so the CodeMirror keymap can pick out the
// ones with shortcuts and the context menu can offer every tag. It holds
// every tag on F-list's wiki list of BBCode tags, plus [spoiler].
export const TOOLBAR_ACTIONS: ToolbarAction[] = [
  { label: 'B', title: 'Bold', shortcut: 'Mod-b', wrap: { open: '[b]', close: '[/b]' } },
  { label: 'I', title: 'Italic', shortcut: 'Mod-i', wrap: { open: '[i]', close: '[/i]' } },
  { label: 'U', title: 'Underline', shortcut: 'Mod-u', wrap: { open: '[u]', close: '[/u]' } },
  { label: 'S', title: 'Strikethrough', wrap: { open: '[s]', close: '[/s]' } },
  { label: 'big', title: 'Big text', wrap: { open: '[big]', close: '[/big]' } },
  { label: 'small', title: 'Small text', wrap: { open: '[small]', close: '[/small]' } },
  { label: 'sub', title: 'Subscript', wrap: { open: '[sub]', close: '[/sub]' } },
  { label: 'sup', title: 'Superscript', wrap: { open: '[sup]', close: '[/sup]' } },
  { label: 'color', title: 'Colour — pick a named swatch', popover: 'color' },
  { label: 'icon', title: 'Character icon', wrap: { open: '[icon]', close: '[/icon]' } },
  { label: 'eicon', title: 'Emote icon — pick from catalog', popover: 'eicon' },
  { label: 'url', title: 'URL — pick a target', shortcut: 'Mod-k', popover: 'url' },
  { label: 'user', title: 'User link', wrap: { open: '[user]', close: '[/user]' } },
  { label: 'heading', title: 'Heading', wrap: { open: '[heading]', close: '[/heading]' } },
  { label: 'spoiler', title: 'Spoiler', wrap: { open: '[spoiler]', close: '[/spoiler]' } },
  {
    label: 'collapse',
    title: 'Collapse',
    wrap: { open: '[collapse=Show]', close: '[/collapse]' }
  },
  { label: 'quote', title: 'Quote block', wrap: { open: '[quote]', close: '[/quote]' } },
  { label: 'left', title: 'Align left', wrap: { open: '[left]', close: '[/left]' } },
  { label: 'center', title: 'Centre', wrap: { open: '[center]', close: '[/center]' } },
  { label: 'right', title: 'Align right', wrap: { open: '[right]', close: '[/right]' } },
  { label: 'justify', title: 'Justify', wrap: { open: '[justify]', close: '[/justify]' } },
  { label: 'indent', title: 'Indent', wrap: { open: '[indent]', close: '[/indent]' } },
  { label: 'hr', title: 'Horizontal rule', insert: '[hr]' },
  {
    label: 'noparse',
    title: 'No parse — show raw BBCode',
    wrap: { open: '[noparse]', close: '[/noparse]' }
  }
]

function actionsLabelled(...labels: string[]): ToolbarAction[] {
  return labels.map((label) => TOOLBAR_ACTIONS.find((a) => a.label === label)!)
}

// Visual grouping for the toolbar, every tag in one row (it wraps when
// the pane is narrow). Order within each group is the order rendered.
const TOOLBAR_GROUPS: ToolbarGroup[] = [
  { key: 'format', actions: actionsLabelled('B', 'I', 'U', 'S') },
  { key: 'size', actions: actionsLabelled('big', 'small', 'sub', 'sup') },
  { key: 'colour', actions: actionsLabelled('color') },
  { key: 'refs', actions: actionsLabelled('icon', 'eicon', 'url', 'user') },
  { key: 'blocks', actions: actionsLabelled('heading', 'spoiler', 'collapse', 'quote') },
  { key: 'align', actions: actionsLabelled('left', 'center', 'right', 'justify', 'indent') },
  { key: 'structural', actions: actionsLabelled('hr', 'noparse') }
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
        const cursor = range.from + action.insert.length
        return {
          changes: { from: range.from, to: range.to, insert: action.insert },
          range: EditorSelection.cursor(cursor)
        }
      }
      const { open, close } = action.wrap!
      const selected = view.state.doc.sliceString(range.from, range.to)
      const insert = open + selected + close
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.range(
          range.from + open.length,
          range.from + open.length + selected.length
        )
      }
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
        range: EditorSelection.range(
          range.from + open.length,
          range.from + open.length + selected.length
        )
      }
    })
  )
  view.focus()
}

function ToolButton({
  action,
  viewRef,
  disabled
}: {
  action: ToolbarAction
  viewRef: RefObject<EditorView | null>
  disabled?: boolean
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
        title={disabled ? `${title} — read-only` : title}
        aria-label={title}
        aria-expanded={action.popover ? popoverOpen : undefined}
        disabled={disabled}
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
      {action.popover === 'eicon' && popoverOpen && (
        <EiconPopover
          onPick={(name) => {
            const view = viewRef.current
            if (view) {
              applyAction(view, {
                label: 'eicon',
                title: 'Emote icon',
                insert: `[eicon]${name}[/eicon]`
              })
            }
            setPopoverOpen(false)
          }}
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
          range: EditorSelection.cursor(range.from + insert.length)
        }
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

function EiconPopover({
  onPick,
  onClose
}: {
  onPick: (name: string) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<string[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [total, setTotal] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    const t = setTimeout(() => {
      api
        .eiconsSearch(query, 200, { signal: controller.signal })
        .then((data) => {
          setResults(data.eicons)
          setStatus(data.status)
          setTotal(data.total)
        })
        .catch((e) => {
          if (controller.signal.aborted) return
          console.warn('eicon search failed', e)
          setStatus('error')
        })
    }, 120)
    return () => {
      controller.abort()
      clearTimeout(t)
    }
  }, [query])

  return (
    <div
      className="tool-popover tool-eicon-popover"
      role="dialog"
      aria-label="Select an eicon"
      data-testid="toolbar-eicon-popover"
    >
      <div className="tool-eicon-header">
        <input
          ref={inputRef}
          type="search"
          className="tool-eicon-search"
          placeholder="Search eicons…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose()
          }}
          data-testid="toolbar-eicon-search"
        />
        <span className="tool-eicon-status">
          {status === 'loading' && 'Loading catalog…'}
          {status === 'ready' && `${total.toLocaleString()} eicons`}
          {status === 'error' && 'Catalog unavailable'}
        </span>
      </div>
      <div className="tool-eicon-grid" data-testid="toolbar-eicon-grid">
        {results.length === 0 && status === 'ready' && query.trim() && (
          <div className="tool-eicon-empty">No matches.</div>
        )}
        {results.map((name) => (
          <button
            key={name}
            type="button"
            className="tool-eicon-tile"
            title={name}
            onClick={() => onPick(name)}
            data-testid={`toolbar-eicon-tile-${name}`}
          >
            <img
              src={`https://static.f-list.net/images/eicon/${encodeURIComponent(name)}.gif`}
              alt={name}
              loading="lazy"
            />
          </button>
        ))}
      </div>
    </div>
  )
}

/** The BBCode bar, and the one place the Code/Split/Preview toggle
 *  lives.
 *
 *  `disabled` dims the formatting buttons for a read-only document
 *  instead of unmounting the bar. The bar is 27px of chrome above the
 *  text: dropping it moved every line up by that much, so toggling
 *  between Live on F-List and the Workbench made the passage you were
 *  reading jump — worst at the top of the document, where there is no
 *  scroll position to anchor it. The view-mode toggle stays live
 *  either way; choosing how to look at a document is not an edit. */
export function Toolbar({
  viewRef,
  disabled
}: {
  viewRef: RefObject<EditorView | null>
  disabled?: boolean
}) {
  return (
    <div
      className="editor-toolbar"
      role="toolbar"
      aria-label="BBCode formatting"
      data-disabled={disabled ? 'true' : undefined}
      data-testid="editor-toolbar"
    >
      {TOOLBAR_GROUPS.map((group, idx) => (
        <span key={group.key} className="tool-group" data-group={group.key}>
          {group.actions.map((a) => (
            <ToolButton
              key={a.label}
              action={a}
              viewRef={viewRef}
              disabled={disabled}
            />
          ))}
          {idx < TOOLBAR_GROUPS.length - 1 && <span className="tool-divider" aria-hidden />}
        </span>
      ))}
      <ViewModeToggle />
    </div>
  )
}

function ViewModeToggle() {
  const mode = useStore((s) => s.editorViewMode)
  const setMode = useStore((s) => s.setEditorViewMode)
  return (
    <span
      className="tool-group tool-view-mode"
      role="group"
      aria-label="View mode"
      data-testid="editor-view-mode"
    >
      <span className="tool-divider" aria-hidden />
      <button
        type="button"
        className={`tool tool-view-mode-btn${mode === 'code' ? ' on' : ''}`}
        aria-pressed={mode === 'code'}
        title="Full code — hide live preview"
        onClick={() => setMode('code')}
        data-testid="view-mode-code"
      >
        Code
      </button>
      <button
        type="button"
        className={`tool tool-view-mode-btn${mode === 'split' ? ' on' : ''}`}
        aria-pressed={mode === 'split'}
        title="Split — code editor + live preview"
        onClick={() => setMode('split')}
        data-testid="view-mode-split"
      >
        Split
      </button>
      <button
        type="button"
        className={`tool tool-view-mode-btn${mode === 'preview' ? ' on' : ''}`}
        aria-pressed={mode === 'preview'}
        title="Full preview — hide the code editor"
        onClick={() => setMode('preview')}
        data-testid="view-mode-preview"
      >
        Preview
      </button>
    </span>
  )
}
