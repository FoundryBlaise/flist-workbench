import { EditorView } from '@codemirror/view'
import type { RefObject } from 'react'

export type ToolbarAction = {
  label: string
  title: string
  /** Optional keyboard shortcut, e.g. "Mod-b". Mod = Cmd on Mac, Ctrl elsewhere. */
  shortcut?: string
  wrap?: { open: string; close: string }
  insert?: string
}

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

export function Toolbar({ viewRef }: { viewRef: RefObject<EditorView | null> }) {
  return (
    <div className="editor-toolbar" role="toolbar" aria-label="BBCode formatting">
      {TOOLBAR_ACTIONS.map((a) => {
        const title = a.shortcut ? `${a.title} (${shortcutLabel(a.shortcut)})` : a.title
        return (
          <button
            key={a.label}
            type="button"
            className="tool"
            title={title}
            aria-label={title}
            onClick={() => {
              const view = viewRef.current
              if (view) applyAction(view, a)
            }}
          >
            {a.label}
          </button>
        )
      })}
    </div>
  )
}
