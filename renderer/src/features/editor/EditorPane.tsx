import { useEffect, useMemo, useRef, useState } from 'react'
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { useStore } from '../../state'
import { bbcodeExtensions } from '../../lib/bbcode/codemirror'
import { displayCharacter } from '../../lib/partnerName'
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
  const activeCharacter = useStore((s) => s.activeCharacter)
  const readOnly = useStore((s) => s.editorReadOnly)
  // F-list working-copy + logs-only signals for the editor banners.
  // Working copies live in memory (Tier 1 — see PHASE7_TIER1_PLAN.md);
  // logs-only chars don't have a profile to edit. Each banner is shown
  // when the editor is in the matching mode + not read-only.
  const flistActiveId = useStore((s) => s.flistActiveCharacterId)
  const flistWorkingForActive = useStore((s) =>
    s.flistActiveCharacterId ? s.flistWorking[s.flistActiveCharacterId] : undefined
  )
  const flistActiveRosterEntry = useStore((s) =>
    s.activeCharacter
      ? s.flistRoster.find(
          (r) => r.name.toLowerCase() === s.activeCharacter!.toLowerCase()
        ) ?? null
      : null
  )
  const workingDirty =
    flistActiveId !== null &&
    activeDocId === null &&
    !readOnly &&
    !!flistWorkingForActive?.dirty
  const isLogsOnly =
    flistActiveId === null &&
    activeDocId === null &&
    !readOnly &&
    flistActiveRosterEntry !== null &&
    !flistActiveRosterEntry.on_account
  const [fetchName, setFetchName] = useState(() =>
    activeCharacter ? displayCharacter(activeCharacter) : ''
  )
  const [progressDots, setProgressDots] = useState(0)
  const [showRevisions, setShowRevisions] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  // Track which char name (if any) the input was last auto-seeded
  // from. If the user has typed something else we leave the input
  // alone; if they're still showing the previous auto-seed (or it's
  // empty) we update on character switch.
  const seededFromRef = useRef<string | null>(activeCharacter)

  const cmRef = useRef<ReactCodeMirrorRef>(null)
  const viewRef = useRef<EditorView | null>(null)
  const prevStatusRef = useRef(fetchStatus)

  // Switching the active character seeds the Fetch input with that
  // character's name so it's a one-click "fetch this alt's profile"
  // instead of typing the name again. Only overwrites the input when
  // the user hasn't typed something custom into it.
  useEffect(() => {
    if (!activeCharacter) return
    const proposed = displayCharacter(activeCharacter)
    const wasAutoSeeded =
      fetchName === '' ||
      (seededFromRef.current !== null && fetchName === displayCharacter(seededFromRef.current))
    if (wasAutoSeeded) {
      setFetchName(proposed)
      seededFromRef.current = activeCharacter
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCharacter])

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

  const extensions = useMemo(
    () =>
      readOnly
        ? [...bbcodeExtensions, EditorView.editable.of(false), EditorState.readOnly.of(true)]
        : bbcodeExtensions,
    [readOnly]
  )

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
        <span className="doc-name">
          {readOnly && <span className="doc-readonly-pill" title="Read-only — pulled from F-list">read-only</span>}
          {dirty ? `● ${title}` : title}
        </span>
        <span
          className="editor-meta"
          title="Length of the BBCode source (the editor on the left). The preview pane shows the rendered text, which is usually shorter because tags are stripped."
        >
          {content.length} chars (source)
        </span>
        {!readOnly && (
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
        )}
        {!readOnly && (
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
        )}
      </header>
      {workingDirty && (
        <div className="editor-working-banner" role="status" data-testid="editor-working-banner">
          <span className="editor-working-banner-icon" aria-hidden>⚠</span>
          <span>
            <b>In-memory edits.</b> Working-copy changes live only in this
            session until Tier 2 lands disk persistence. Closing Workbench will
            discard them — you'll be prompted to confirm.
          </span>
        </div>
      )}
      {isLogsOnly && (
        <div className="editor-logsonly-banner" role="status" data-testid="editor-logsonly-banner">
          <span className="editor-logsonly-banner-icon" aria-hidden>📁</span>
          <span>
            <b>Logs-only character.</b> {activeCharacter} only exists in your
            local F-Chat logs — not on your F-list account. Switch to Logs to
            browse conversations, or pick a different character to edit a
            profile.
          </span>
        </div>
      )}
      {!readOnly && <Toolbar viewRef={viewRef} />}
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
            extensions={extensions}
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
