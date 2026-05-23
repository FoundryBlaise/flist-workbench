import { EditorView } from '@codemirror/view'
import type { RefObject } from 'react'

type ToolbarAction = {
  label: string
  title: string
  wrap?: { open: string; close: string }
  insert?: string
}

const ACTIONS: ToolbarAction[] = [
  { label: 'B', title: 'Bold', wrap: { open: '[b]', close: '[/b]' } },
  { label: 'I', title: 'Italic', wrap: { open: '[i]', close: '[/i]' } },
  { label: 'U', title: 'Underline', wrap: { open: '[u]', close: '[/u]' } },
  { label: 'S', title: 'Strikethrough', wrap: { open: '[s]', close: '[/s]' } },
  { label: 'color', title: 'Colour (red)', wrap: { open: '[color=red]', close: '[/color]' } },
  { label: 'icon', title: 'Character icon', wrap: { open: '[icon]', close: '[/icon]' } },
  { label: 'eicon', title: 'Emote icon', wrap: { open: '[eicon]', close: '[/eicon]' } },
  { label: 'url', title: 'URL', wrap: { open: '[url=https://]', close: '[/url]' } },
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

function applyAction(view: EditorView, action: ToolbarAction) {
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
      {ACTIONS.map((a) => (
        <button
          key={a.label}
          type="button"
          className="tool"
          title={a.title}
          aria-label={a.title}
          onClick={() => {
            const view = viewRef.current
            if (view) applyAction(view, a)
          }}
        >
          {a.label}
        </button>
      ))}
    </div>
  )
}
