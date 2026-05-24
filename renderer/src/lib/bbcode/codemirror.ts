import { EditorView, Decoration, DecorationSet, ViewPlugin, ViewUpdate } from '@codemirror/view'
import { RangeSetBuilder } from '@codemirror/state'
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language'

const TAG_RE = /\[(\/?)([a-zA-Z][a-zA-Z0-9]*)(?:=([^\]]*))?\]/g

const tagDeco = Decoration.mark({ class: 'cm-bb-tag' })
const closeDeco = Decoration.mark({ class: 'cm-bb-tag-close' })
const attrDeco = Decoration.mark({ class: 'cm-bb-attr' })

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

export const bbcodeExtensions = [
  bbcodeDecorations,
  bbcodeTheme,
  dummyHighlight,
  // Profiles routinely contain very long lines (spacer rows of dashes,
  // collapse headers padded with spaces, multi-paragraph quote bodies).
  // Wrap them rather than scroll horizontally so the editor reads the
  // way the preview lays out.
  EditorView.lineWrapping
]
