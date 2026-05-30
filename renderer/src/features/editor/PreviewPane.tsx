import { useEffect, useRef, useState } from 'react'
import { useStore } from '../../state'
import { bbcodeToHtml, bbcodeFromPreviewDom } from '../../lib/bbcode'

const EDIT_HINT_KEY = 'flist-workbench:preview-edit-hint-dismissed'

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
  const readOnly = useStore((s) => s.editorReadOnly)
  const ref = useRef<HTMLDivElement>(null)
  const focusedRef = useRef(false)
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null)
  const [showEditHint, setShowEditHint] = useState(() => {
    if (typeof localStorage === 'undefined') return true
    return localStorage.getItem(EDIT_HINT_KEY) !== '1'
  })
  const dismissEditHint = () => {
    setShowEditHint(false)
    try {
      localStorage.setItem(EDIT_HINT_KEY, '1')
    } catch {
      // private mode / disabled storage — fine, hint just won't persist
    }
  }
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
    // When the surrounding editor is in read-only mode (Live / Backup
    // documents pulled from F-list), block writeback. `contentEditable`
    // is already set to false below, but Chromium still fires `input`
    // for some keyboard shortcuts so we guard here too.
    if (readOnly) return
    const el = ref.current
    if (!el) return
    const next = bbcodeFromPreviewDom(el, renderedFromRef.current)
    setContent(next)
  }

  // Click an inline image → open it in a lightbox. We use event
  // delegation on the preview body so the handler keeps working after
  // any re-render. Escape and clicking the backdrop close the lightbox.
  const handleClick = (e: React.MouseEvent) => {
    const t = e.target as HTMLElement
    if (t.tagName === 'IMG' && t.classList.contains('bb-img')) {
      e.preventDefault()
      e.stopPropagation()
      const img = t as HTMLImageElement
      setLightbox({ src: img.src, alt: img.alt || 'inline image' })
    }
  }

  useEffect(() => {
    if (!lightbox) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightbox(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [lightbox])

  return (
    <section className="pane preview" data-testid="preview-pane">
      <header className="pane-head">
        Live Preview
        {readOnly ? (
          <span className="preview-readonly-hint" title="Pulled from F-list — read-only">
            · read-only
          </span>
        ) : (
          <span className="preview-edit-hint">· editable</span>
        )}
      </header>
      {showEditHint && !readOnly && (
        <div className="preview-edit-banner" data-testid="preview-edit-banner">
          <span className="preview-edit-banner-icon" aria-hidden>
            ✎
          </span>
          <span>
            <b>This preview is live and editable.</b> Click anywhere to fix a
            typo or rephrase a sentence — your changes flow back into the
            source on the left. Structural changes (tags, layout) still go
            in the editor.
          </span>
          <button
            type="button"
            className="preview-edit-banner-close"
            onClick={dismissEditHint}
            aria-label="Dismiss hint"
          >
            Got it · ✕
          </button>
        </div>
      )}
      {lightbox && (
        <div
          className="bb-lightbox"
          data-testid="bb-lightbox"
          onClick={() => setLightbox(null)}
          role="dialog"
          aria-label={lightbox.alt}
        >
          <img src={lightbox.src} alt={lightbox.alt} />
          <button
            type="button"
            className="bb-lightbox-close"
            aria-label="Close"
            onClick={() => setLightbox(null)}
          >
            ✕
          </button>
        </div>
      )}
      <div
        ref={ref}
        className={`pane-body preview-body${readOnly ? ' preview-readonly' : ''}`}
        data-testid="preview-body"
        contentEditable={!readOnly}
        suppressContentEditableWarning
        spellCheck={false}
        onInput={handleInput}
        onClick={handleClick}
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
