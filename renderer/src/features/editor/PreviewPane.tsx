import { useEffect, useRef, useState } from 'react'
import { useStore } from '../../state'
import { bbcodeToHtml, bbcodeFromPreviewDom } from '../../lib/bbcode'
import {
  EDITOR_SELECTION_EVENT,
  type EditorSelectionDetail
} from '../../lib/bbcode/codemirror'
import { ProfileFieldsPreview } from '../flist/ProfileFieldsPreview'

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
  const editorActiveTab = useStore((s) => s.editorActiveTab)
  const flistActiveId = useStore((s) => s.flistActiveCharacterId)
  // Profile fields tab gets a website-style Info-pane preview instead
  // of the BBCode preview — the BBCode renderer has nothing to show
  // for that tab's edits. Only the Description tab actually drives the
  // BBCode preview; the other working-copy tabs stay on it for now.
  const showProfileFieldsPreview =
    editorActiveTab === 'profile-fields' && flistActiveId !== null
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
    if (showProfileFieldsPreview) return
    const el = ref.current
    if (!el) return
    if (focusedRef.current) return
    // Empty innerHTML wins over the cached-source guard — that's the
    // signal that the <div> just remounted after a tab swap and needs
    // re-population even though `content` hasn't changed.
    if (renderedFromRef.current === content && el.innerHTML !== '') return
    const opens = captureOpenCollapses(el)
    el.innerHTML = bbcodeToHtml(content, { withSourceMap: true, inlines })
    applyOpenCollapses(el, opens)
    renderedFromRef.current = content
  }, [content, inlines, showProfileFieldsPreview])

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

  // Mirror the editor selection: light up every text span whose source
  // range overlaps the editor's selection. Granularity is per-span (the
  // BBCode renderer wraps each text segment with [data-bb-start/end]),
  // so selecting half a word lights up the whole containing span — we
  // can't sub-highlight without splitting nodes and fighting the
  // bidirectional-edit path. rAF-batched to coalesce caret-drag bursts.
  useEffect(() => {
    let raf = 0
    const apply = (from: number, to: number) => {
      const el = ref.current
      if (!el) return
      const prev = el.querySelectorAll<HTMLElement>('.bb-selected')
      for (const node of prev) node.classList.remove('bb-selected')
      // Don't paint a mirror while the user is typing in the preview —
      // the highlight would overlap their own caret-area edits and read
      // as a glitch. The editor's own selection still drives the
      // CodeMirror caret as usual.
      if (focusedRef.current) return
      if (from === to) return
      const spans = el.querySelectorAll<HTMLElement>('[data-bb-start]')
      for (const node of spans) {
        const s = Number(node.getAttribute('data-bb-start'))
        const e = Number(node.getAttribute('data-bb-end'))
        if (s < to && e > from) node.classList.add('bb-selected')
      }
    }
    const onSel = (e: Event) => {
      const detail = (e as CustomEvent<EditorSelectionDetail>).detail
      if (!detail) return
      if (raf) cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => apply(detail.from, detail.to))
    }
    window.addEventListener(EDITOR_SELECTION_EVENT, onSel)
    return () => {
      window.removeEventListener(EDITOR_SELECTION_EVENT, onSel)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])

  return (
    <section className="pane preview" data-testid="preview-pane">
      <header className="pane-head">
        {showProfileFieldsPreview ? 'Info Preview' : 'Live Preview'}
        {showProfileFieldsPreview ? null : readOnly ? (
          <span className="preview-readonly-hint" title="Pulled from F-list — read-only">
            · read-only
          </span>
        ) : (
          <span className="preview-edit-hint">· editable</span>
        )}
      </header>
      {showEditHint && !readOnly && !showProfileFieldsPreview && (
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
      {showProfileFieldsPreview ? (
        <ProfileFieldsPreview />
      ) : (
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
      )}
    </section>
  )
}
