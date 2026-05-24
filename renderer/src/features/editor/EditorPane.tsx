import { useEffect, useRef, useState } from 'react'
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { EditorView } from '@codemirror/view'
import { useStore } from '../../state'
import { bbcodeExtensions } from '../../lib/bbcode/codemirror'
import { Toolbar } from './Toolbar'
import { RevisionsPanel } from './RevisionsPanel'

// Idle window before a draft autosave flushes. Crash-safety only —
// drafts overwrite themselves, so 30 s is the sweet spot between "fresh
// enough to recover the last sentence" and "not hammering the sidecar".
const DRAFT_IDLE_MS = 30_000

export function EditorPane() {
  const content = useStore((s) => s.editorContent)
  const setContent = useStore((s) => s.setEditorContent)
  const title = useStore((s) => s.editorTitle)
  const dirty = useStore((s) => s.editorDirty)
  const fetchStatus = useStore((s) => s.editorFetchStatus)
  const fetchError = useStore((s) => s.editorFetchError)
  const fetchProfile = useStore((s) => s.fetchProfile)
  const saveStatus = useStore((s) => s.saveStatus)
  const saveError = useStore((s) => s.saveError)
  const draftStatus = useStore((s) => s.draftStatus)
  const activeDocId = useStore((s) => s.activeDocId)
  const saveActiveDocument = useStore((s) => s.saveActiveDocument)
  const saveActiveDraft = useStore((s) => s.saveActiveDraft)
  const [fetchName, setFetchName] = useState('Azure Viper')
  const [progressDots, setProgressDots] = useState(0)
  const [showRevisions, setShowRevisions] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const cmRef = useRef<ReactCodeMirrorRef>(null)
  const viewRef = useRef<EditorView | null>(null)
  const prevStatusRef = useRef(fetchStatus)

  // Slow F-list profile fetches (5-10 s on a cold CDN) only changed the
  // button label, which reads as "frozen UI" to anyone not watching the
  // word. Tick a dots animation so users see motion. Cleared as soon as
  // the fetch resolves.
  useEffect(() => {
    if (fetchStatus !== 'fetching') {
      setProgressDots(0)
      return
    }
    const t = setInterval(() => setProgressDots((n) => (n + 1) % 4), 350)
    return () => clearInterval(t)
  }, [fetchStatus])

  // On a successful fetch, clear the seed name and hand focus to the
  // editor — the user is done with the fetch input now, and leaving the
  // last name in the field invites accidental re-clobber on the next
  // Enter.
  useEffect(() => {
    if (prevStatusRef.current === 'fetching' && fetchStatus === 'ok') {
      setFetchName('')
      viewRef.current?.focus()
    }
    prevStatusRef.current = fetchStatus
  }, [fetchStatus])

  // Autosave to draft slot after the user has been idle for a moment.
  // Drafts are crash-safety, not history — they overwrite the same row
  // each time. An explicit Save (Ctrl+S below) promotes a draft into a
  // real revision.
  useEffect(() => {
    if (!dirty || activeDocId === null) return
    const t = setTimeout(() => {
      void saveActiveDraft()
    }, DRAFT_IDLE_MS)
    return () => clearTimeout(t)
  }, [dirty, content, activeDocId, saveActiveDraft])

  // Ctrl+S anywhere in the pane → save a real revision. Keep it on the
  // window level (not the CodeMirror keymap) so it also fires while the
  // user has focus in the fetch input or the toolbar.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (activeDocId !== null && dirty) void saveActiveDocument()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeDocId, dirty, saveActiveDocument])

  const submitFetch = (name: string) => {
    const trimmed = name.trim()
    // Drop empty submits silently — the button is disabled but Enter
    // on the input would otherwise still hit the API with a blank.
    if (!trimmed) return
    if (fetchStatus === 'fetching') return
    if (dirty) {
      const ok = window.confirm(
        `Replace the current document with "${trimmed}"? Your unsaved edits will be lost.`
      )
      if (!ok) return
    }
    void fetchProfile(trimmed)
  }

  const saveLabel =
    saveStatus === 'saving'
      ? 'Saving…'
      : saveStatus === 'saved'
        ? 'Saved'
        : dirty
          ? 'Save'
          : 'Saved'
  const saveDisabled =
    saveStatus === 'saving' || activeDocId === null || (!dirty && saveStatus !== 'error')

  return (
    <section className="pane editor-pane" data-testid="editor-pane">
      <header className="pane-head editor-head">
        <span className="doc-name">{dirty ? `● ${title}` : title}</span>
        <span
          className="editor-meta"
          title="Length of the BBCode source (the editor on the left). The preview pane shows the rendered text, which is usually shorter because tags are stripped."
        >
          {content.length} chars (source)
        </span>
        <div className="editor-doc-actions">
          <button
            type="button"
            className="doc-save"
            data-testid="doc-save"
            onClick={() => {
              if (activeDocId !== null) void saveActiveDocument()
            }}
            disabled={saveDisabled}
            title="Save a new revision (Ctrl+S)"
          >
            {saveLabel}
          </button>
          <button
            type="button"
            className="doc-revisions-toggle"
            onClick={() => setShowRevisions((v) => !v)}
            aria-pressed={showRevisions}
            title="Show revision history"
            data-testid="doc-revisions-toggle"
          >
            History
          </button>
          {draftStatus === 'saved' && dirty && (
            <span className="draft-indicator" title="Crash-recovery draft saved">
              draft saved
            </span>
          )}
        </div>
        <form
          className="profile-fetch"
          onSubmit={(e) => {
            e.preventDefault()
            submitFetch(fetchName)
          }}
        >
          <input
            ref={inputRef}
            type="text"
            placeholder="Character name…"
            value={fetchName}
            onChange={(e) => setFetchName(e.target.value)}
            data-testid="profile-fetch-input"
            disabled={fetchStatus === 'fetching'}
          />
          <button
            type="submit"
            disabled={fetchStatus === 'fetching' || !fetchName.trim()}
            data-testid="profile-fetch-submit"
          >
            {fetchStatus === 'fetching'
              ? `Fetching${'.'.repeat(progressDots)}`
              : 'Fetch profile'}
          </button>
        </form>
      </header>
      <Toolbar viewRef={viewRef} />
      {fetchStatus === 'fetching' && (
        <div className="editor-progress" data-testid="editor-progress">
          <div className="editor-progress-bar" />
          <span>Fetching profile from F-list…</span>
        </div>
      )}
      {fetchStatus === 'error' && (
        <div className="editor-error">Couldn't fetch: {fetchError}</div>
      )}
      {saveStatus === 'error' && (
        <div className="editor-error">Couldn't save: {saveError}</div>
      )}
      <div className="editor-cm-row">
        <div className="editor-cm" data-testid="editor-cm">
          <CodeMirror
            ref={cmRef}
            value={content}
            theme="dark"
            extensions={bbcodeExtensions}
            basicSetup={{
              lineNumbers: false,
              foldGutter: false,
              highlightActiveLine: false,
              highlightActiveLineGutter: false,
              indentOnInput: false
            }}
            onChange={(value) => setContent(value)}
            onCreateEditor={(view) => {
              viewRef.current = view
            }}
          />
        </div>
        {showRevisions && activeDocId !== null && (
          <RevisionsPanel docId={activeDocId} onClose={() => setShowRevisions(false)} />
        )}
      </div>
    </section>
  )
}
