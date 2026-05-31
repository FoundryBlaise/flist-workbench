import { EditorView, Decoration, DecorationSet, ViewPlugin, ViewUpdate, keymap } from '@codemirror/view'
import { Prec, RangeSetBuilder } from '@codemirror/state'
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language'
import { TOOLBAR_ACTIONS, applyAction } from '../../features/editor/Toolbar'
import { bbcodeAutocomplete } from './autocomplete'

const TAG_RE = /\[(\/?)([a-zA-Z][a-zA-Z0-9]*)(?:=([^\]]*))?\]/g

const tagDeco = Decoration.mark({ class: 'cm-bb-tag' })
const closeDeco = Decoration.mark({ class: 'cm-bb-tag-close' })
const attrDeco = Decoration.mark({ class: 'cm-bb-attr' })
const tagMatchDeco = Decoration.mark({ class: 'cm-bb-tag-match' })

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to)
    for (const m of text.matchAll(TAG_RE)) {
      const start = from + (m.index ?? 0)
      const end = start + m[0].length
      const isClose = m[1] === '/'
      builder.add(start, end, isClose ? closeDeco : tagDeco)
      const eq = m[0].indexOf('=')
      if (eq !== -1 && m[3] !== undefined) {
        builder.add(start + eq + 1, end - 1, attrDeco)
      }
    }
  }
  return builder.finish()
}

const bbcodeDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view)
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = buildDecorations(u.view)
    }
  },
  { decorations: (v) => v.decorations }
)

// Tag-pair matcher — when the caret sits inside a [tag] or [/tag],
// underline both halves of the pair. Uses a stack walk by tag name so
// nested same-name tags ([b][b]…[/b][/b]) pair correctly. Tags with no
// counterpart (self-closing like [hr], or unbalanced soup) get no
// decoration rather than a misleading partial highlight.
interface BBTag {
  start: number
  end: number
  name: string
  isClose: boolean
}

function scanTagsAll(text: string): BBTag[] {
  const out: BBTag[] = []
  for (const m of text.matchAll(TAG_RE)) {
    const start = m.index ?? 0
    out.push({
      start,
      end: start + m[0].length,
      name: m[2].toLowerCase(),
      isClose: m[1] === '/'
    })
  }
  return out
}

function findTagAt(tags: BBTag[], pos: number): number {
  for (let i = 0; i < tags.length; i++) {
    if (pos >= tags[i].start && pos <= tags[i].end) return i
  }
  return -1
}

function findMatch(tags: BBTag[], idx: number): number {
  const target = tags[idx]
  if (target.isClose) {
    let depth = 1
    for (let i = idx - 1; i >= 0; i--) {
      const t = tags[i]
      if (t.name !== target.name) continue
      if (t.isClose) depth++
      else if (--depth === 0) return i
    }
  } else {
    let depth = 1
    for (let i = idx + 1; i < tags.length; i++) {
      const t = tags[i]
      if (t.name !== target.name) continue
      if (!t.isClose) depth++
      else if (--depth === 0) return i
    }
  }
  return -1
}

function buildTagMatchDecorations(view: EditorView): DecorationSet {
  const sel = view.state.selection.main
  // Only highlight while the cursor is collapsed — a multi-char range
  // is the user doing a normal selection, not pointing at a single tag.
  if (sel.from !== sel.to) return Decoration.none
  const tags = scanTagsAll(view.state.doc.toString())
  const at = findTagAt(tags, sel.from)
  if (at === -1) return Decoration.none
  const partner = findMatch(tags, at)
  if (partner === -1) return Decoration.none
  const builder = new RangeSetBuilder<Decoration>()
  const [first, second] = at < partner ? [tags[at], tags[partner]] : [tags[partner], tags[at]]
  builder.add(first.start, first.end, tagMatchDeco)
  builder.add(second.start, second.end, tagMatchDeco)
  return builder.finish()
}

const bbcodeTagMatch = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = buildTagMatchDecorations(view)
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet) {
        this.decorations = buildTagMatchDecorations(u.view)
      }
    }
  },
  { decorations: (v) => v.decorations }
)

const bbcodeTheme = EditorView.theme(
  {
    '&': {
      backgroundColor: '#1e1e1e',
      color: '#d4d4d4',
      height: '100%',
      fontSize: '13px'
    },
    '.cm-content': {
      fontFamily: "'Cascadia Code', Consolas, 'JetBrains Mono', monospace",
      padding: '12px'
    },
    '.cm-gutters': { display: 'none' },
    '.cm-cursor': { borderLeftColor: '#d4d4d4' },
    '.cm-selectionBackground, ::selection': { backgroundColor: '#094771 !important' },
    '.cm-bb-tag': { color: '#569cd6' },
    '.cm-bb-tag-close': { color: '#c97070' },
    '.cm-bb-attr': { color: '#6a9955' },
    '.cm-focused': { outline: 'none' }
  },
  { dark: true }
)

const dummyHighlight = syntaxHighlighting(HighlightStyle.define([]))

// Bind every TOOLBAR_ACTION that declares a shortcut into the editor
// keymap. Ctrl/Cmd+B/I/U/etc. wrap the current selection the same way
// clicking the toolbar button does. Wrap in Prec.highest because the
// CodeMirror default keymap binds Mod-u to undoSelection and would
// otherwise win the race for that chord.
const bbcodeShortcuts = Prec.highest(
  keymap.of(
    TOOLBAR_ACTIONS.filter((a) => a.shortcut).map((a) => ({
      key: a.shortcut!,
      preventDefault: true,
      stopPropagation: true,
      run: (view) => {
        applyAction(view, a)
        return true
      }
    }))
  )
)

// Broadcasts the current editor selection so the preview pane can
// mirror it (highlight the rendered region matching the selected
// source). Custom DOM event keeps the two panes loosely coupled — no
// shared store entry, no React re-renders in the editor side.
const SELECTION_EVENT = 'flist-workbench:editor-selection'

const selectionBroadcast = EditorView.updateListener.of((u) => {
  if (!u.selectionSet && !u.docChanged) return
  const s = u.state.selection.main
  window.dispatchEvent(
    new CustomEvent(SELECTION_EVENT, { detail: { from: s.from, to: s.to } })
  )
})

export type EditorSelectionDetail = { from: number; to: number }
export const EDITOR_SELECTION_EVENT = SELECTION_EVENT

export const bbcodeExtensions = [
  bbcodeDecorations,
  bbcodeTagMatch,
  bbcodeTheme,
  dummyHighlight,
  // Profiles routinely contain very long lines (spacer rows of dashes,
  // collapse headers padded with spaces, multi-paragraph quote bodies).
  // Wrap them rather than scroll horizontally so the editor reads the
  // way the preview lays out.
  EditorView.lineWrapping,
  bbcodeAutocomplete,
  bbcodeShortcuts,
  selectionBroadcast
]
