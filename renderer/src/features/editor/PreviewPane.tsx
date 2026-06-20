import { useEffect, useRef, useState } from 'react'
import { useStore } from '../../state'
import { bbcodeToHtml, bbcodeFromPreviewDom } from '../../lib/bbcode'
import {
  EDITOR_SELECTION_EVENT,
  type EditorSelectionDetail
} from '../../lib/bbcode/codemirror'
import { EditorView } from '@codemirror/view'
import { undo, redo } from '@codemirror/commands'
import { ProfileFieldsPreview } from '../flist/ProfileFieldsPreview'
import { KinksUndecidedPool } from '../flist/KinksUndecidedPool'
import { GalleryPreviewPane } from '../flist/GalleryPreviewPane'

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
  const previewTheme = useStore((s) => s.previewTheme)
  const setPreviewTheme = useStore((s) => s.setPreviewTheme)
  const editorActiveTab = useStore((s) => s.editorActiveTab)
  const flistActiveId = useStore((s) => s.flistActiveCharacterId)
  // Per-tab right pane:
  //   profile-fields → website-style Info preview
  //   kinks          → Undecided pool (interactive in edit mode, locked
  //                    in read-only — same surface, same scroll position
  //                    when you toggle between My edits and From F-list)
  //   anything else  → BBCode preview
  // Read-only just changes how each component sources its data
  // (live archive instead of working copy) — the right-pane shape
  // stays identical so the editor↔read-only switch has zero
  // structural friction.
  const showProfileFieldsPreview =
    editorActiveTab === 'profile-fields' && flistActiveId !== null
  const showKinksPool = editorActiveTab === 'kinks' && flistActiveId !== null
  const showImagesPreview =
    editorActiveTab === 'images' && flistActiveId !== null
  const showAlternatePreview =
    showProfileFieldsPreview || showKinksPool || showImagesPreview
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
    if (showAlternatePreview) return
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
  }, [content, inlines, showAlternatePreview])

  // Browser contentEditable owns its own undo stack, but blurring +
  // refocusing the preview (or any innerHTML rewrite, which our blur
  // handler does) silently clears it. Cmd/Ctrl+Z then becomes a no-op
  // until the user clicks back into the code editor — confusing, and
  // inconsistent with CodeMirror's own undo behaviour.
  //
  // Route the shortcut to CodeMirror's history extension instead: it
  // tracks every change going through the editor view, including the
  // ones our preview→source writeback sends via setContent. We sync
  // the preview DOM manually after the dispatch because focusedRef
  // would otherwise suppress the auto-render effect.
  const handleKeyDown = (e: React.KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey
    if (!mod) return
    const isUndo = !e.shiftKey && e.key.toLowerCase() === 'z'
    const isRedo =
      e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z')
    if (!isUndo && !isRedo) return
    const cmEl = document.querySelector('.cm-editor') as HTMLElement | null
    if (!cmEl) return
    const view = EditorView.findFromDOM(cmEl)
    if (!view) return
    e.preventDefault()
    if (isUndo) undo(view)
    else redo(view)
    const el = ref.current
    if (!el) return
    const next = view.state.doc.toString()
    const opens = captureOpenCollapses(el)
    el.innerHTML = bbcodeToHtml(next, {
      withSourceMap: true,
      inlines: useStore.getState().editorInlines
    })
    applyOpenCollapses(el, opens)
    renderedFromRef.current = next
  }

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
    <section
      className="pane preview"
      data-testid="preview-pane"
      data-flist-theme={showAlternatePreview ? undefined : previewTheme}
    >
      <header className="pane-head">
        {showProfileFieldsPreview
          ? 'Info Preview'
          : showKinksPool
            ? 'Undecided Kinks'
            : showImagesPreview
              ? 'Gallery Preview'
              : 'Live Preview'}
        {showAlternatePreview ? null : readOnly ? (
          <span className="preview-readonly-hint" title="Pulled from F-list — read-only">
            · read-only
          </span>
        ) : (
          <span className="preview-edit-hint">· editable</span>
        )}
        {showAlternatePreview ? null : (
          <div
            className="preview-theme-switch"
            role="group"
            aria-label="F-list theme"
            data-testid="preview-theme-switch"
          >
            {(['dark', 'default', 'light'] as const).map((t) => (
              <button
                key={t}
                type="button"
                className={`preview-theme-btn${previewTheme === t ? ' on' : ''}`}
                aria-pressed={previewTheme === t}
                title={`Preview as F-list ${t[0].toUpperCase() + t.slice(1)} theme`}
                onClick={() => setPreviewTheme(t)}
              >
                {t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
        )}
      </header>
      {showEditHint && !readOnly && !showAlternatePreview && (
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
      ) : showKinksPool ? (
        <KinksUndecidedPool />
      ) : showImagesPreview ? (
        <GalleryPreviewPane />
      ) : (
        <div
          ref={ref}
          className={`pane-body preview-body${readOnly ? ' preview-readonly' : ''}`}
          data-testid="preview-body"
          contentEditable={!readOnly}
          suppressContentEditableWarning
          spellCheck={false}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
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
