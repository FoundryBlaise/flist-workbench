import { useEffect, useRef } from 'react'
import { useStore } from '../../state'
import { bbcodeToHtml, bbcodeFromPreviewDom } from '../../lib/bbcode'

/**
 * Preview pane is contentEditable. Edits inside any text span flow back
 * into the BBCode source, so typing/correcting in the rendered preview
 * updates the editor immediately. Structural changes (adding tags, etc.)
 * still belong in the editor or its toolbar.
 *
 * Two things make this work without React fighting the DOM:
 *
 * 1. We manage innerHTML imperatively via a ref instead of
 *    dangerouslySetInnerHTML. Otherwise React would overwrite the DOM
 *    on every editorContent change and erase the user's caret.
 *
 * 2. When the preview owns focus we skip re-rendering it from
 *    editorContent — the user IS the source of truth at that moment.
 *    A blur or external content swap (e.g. Fetch profile) triggers a
 *    fresh render so the spans get their source offsets back.
 */
// Capture which <details class="bb-collapse"> are currently open before
// we throw away the DOM, and re-apply that state to the next render's
// details elements in document order. Without this, a re-render closes
// every collapse the user had opened — which feels like the click did
// nothing on the second beat.
function captureOpenCollapses(root: HTMLElement): boolean[] {
  return Array.from(root.querySelectorAll<HTMLDetailsElement>('details.bb-collapse')).map(
    (d) => d.open
  )
}

function applyOpenCollapses(root: HTMLElement, openStates: boolean[]): void {
  const details = root.querySelectorAll<HTMLDetailsElement>('details.bb-collapse')
  for (let i = 0; i < details.length && i < openStates.length; i++) {
    details[i].open = openStates[i]
  }
}

export function PreviewPane() {
  const content = useStore((s) => s.editorContent)
  const inlines = useStore((s) => s.editorInlines)
  const setContent = useStore((s) => s.setEditorContent)
  const ref = useRef<HTMLDivElement>(null)
  const focusedRef = useRef(false)
  // Track which source the current DOM was rendered from. When the user
  // types into the preview we use this as the "before" snapshot to
  // reverse-map edits back into BBCode.
  const renderedFromRef = useRef('')

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (focusedRef.current) return
    if (renderedFromRef.current === content) return
    const opens = captureOpenCollapses(el)
    el.innerHTML = bbcodeToHtml(content, { withSourceMap: true, inlines })
    applyOpenCollapses(el, opens)
    renderedFromRef.current = content
  }, [content, inlines])

  const handleInput = () => {
    const el = ref.current
    if (!el) return
    const next = bbcodeFromPreviewDom(el, renderedFromRef.current)
    setContent(next)
  }

  return (
    <section className="pane preview" data-testid="preview-pane">
      <header className="pane-head">Live Preview <span className="preview-edit-hint">· editable</span></header>
      <div
        ref={ref}
        className="pane-body preview-body"
        data-testid="preview-body"
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        onInput={handleInput}
        onFocus={() => {
          focusedRef.current = true
        }}
        onBlur={() => {
          focusedRef.current = false
          // Re-render only if source actually changed during this edit
          // session — otherwise we'd needlessly reset open collapses,
          // scroll position, and anything else outside React's
          // knowledge. Source-map offsets only need refreshing when
          // source moved.
          if (!ref.current) return
          const s = useStore.getState()
          if (renderedFromRef.current === s.editorContent) return
          const opens = captureOpenCollapses(ref.current)
          ref.current.innerHTML = bbcodeToHtml(s.editorContent, {
            withSourceMap: true,
            inlines: s.editorInlines
          })
          applyOpenCollapses(ref.current, opens)
          renderedFromRef.current = s.editorContent
        }}
      />
    </section>
  )
}
