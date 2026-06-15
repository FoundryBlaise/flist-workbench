import { useEffect, useMemo, useRef, useState } from 'react'
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { selectWorkingSlot, useStore } from '../../state'
import { bbcodeExtensions } from '../../lib/bbcode/codemirror'
import { ProfileFieldsTab } from '../flist/ProfileFieldsTab'
import { KinksPane } from '../flist/KinksPane'
import { ProfileFieldsPreview } from '../flist/ProfileFieldsPreview'
import { DiffPane } from '../flist/DiffPane'
import { ImagesTab } from '../flist/ImagesTab'
import { Toolbar } from './Toolbar'
import { RevisionsPanel } from './RevisionsPanel'
import { useEditorTabs } from './useEditorTabs'

// Idle window before a draft autosave flushes. Crash-safety only —
// drafts overwrite themselves, so 30 s is the sweet spot between "fresh
// enough to recover the last sentence" and "not hammering the sidecar".
const DRAFT_IDLE_MS = 30_000

export function EditorPane() {
  const content = useStore((s) => s.editorContent)
  const setContent = useStore((s) => s.setEditorContent)
  const titleRaw = useStore((s) => s.editorTitle)
  // Reactive title — the underlying editorTitle is set once at openWorking
  // time and stays stale as unsavedDirty flips. Wrap it here so the
  // " — My edits (unsaved)" suffix tracks per-keystroke (QA P3-1).
  const flistActiveIdForTitle = useStore((s) => s.flistActiveCharacterId)
  const flistSlotForTitle = useStore((s) =>
    s.flistActiveCharacterId ? selectWorkingSlot(s, s.flistActiveCharacterId) : undefined
  )
  const title = (() => {
    if (!flistActiveIdForTitle || !flistSlotForTitle) return titleRaw
    const m = titleRaw.match(/^(.+?) — My edits(?:\s*\(unsaved\))?$/)
    if (!m) return titleRaw
    return `${m[1]} — My edits${flistSlotForTitle.unsavedDirty ? ' (unsaved)' : ''}`
  })()
  const dirty = useStore((s) => s.editorDirty)
  const fetchStatus = useStore((s) => s.editorFetchStatus)
  const fetchError = useStore((s) => s.editorFetchError)
  const saveStatus = useStore((s) => s.saveStatus)
  const saveError = useStore((s) => s.saveError)
  const draftStatus = useStore((s) => s.draftStatus)
  const activeDocId = useStore((s) => s.activeDocId)
  const saveActiveDocument = useStore((s) => s.saveActiveDocument)
  const saveActiveDraft = useStore((s) => s.saveActiveDraft)
  const activeCharacter = useStore((s) => s.activeCharacter)
  const readOnly = useStore((s) => s.editorReadOnly)
  // F-list working-copy + logs-only signals for the editor banners.
  // Tier 2 made working copies persistent so the "in-memory edits"
  // warning is gone; we surface a "saving / saved / error" chip instead.
  const flistActiveId = useStore((s) => s.flistActiveCharacterId)
  const flistWorkingForActive = useStore((s) =>
    s.flistActiveCharacterId ? selectWorkingSlot(s, s.flistActiveCharacterId) : undefined
  )
  const flistActiveRosterEntry = useStore((s) =>
    s.activeCharacter
      ? s.flistRoster.find(
          (r) => r.name.toLowerCase() === s.activeCharacter!.toLowerCase()
        ) ?? null
      : null
  )
  const workingCopyMode =
    flistActiveId !== null && activeDocId === null && !readOnly
  const workingSaveStatus = workingCopyMode
    ? flistWorkingForActive?.saveStatus ?? 'idle'
    : 'idle'
  const workingSaveError = workingCopyMode
    ? flistWorkingForActive?.saveError ?? null
    : null
  const workingDirty = workingCopyMode && !!flistWorkingForActive?.unsavedDirty
  const isLogsOnly =
    flistActiveId === null &&
    activeDocId === null &&
    !readOnly &&
    flistActiveRosterEntry !== null &&
    !flistActiveRosterEntry.on_account
  const [showRevisions, setShowRevisions] = useState(false)

  const cmRef = useRef<ReactCodeMirrorRef>(null)
  const viewRef = useRef<EditorView | null>(null)

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
        {!readOnly && activeDocId !== null && (
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
              className="doc-copy"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(content)
                  .catch(() => {
                    // Clipboard may be denied in some sandboxes; surface
                    // nothing — the user can always select-all + ctrl-c.
                  })
              }}
              title="Copy this snippet's BBCode to the clipboard"
              data-testid="doc-copy"
              disabled={!content}
            >
              Copy BBCode
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
      </header>
      {workingCopyMode && (workingSaveStatus !== 'idle' || workingDirty) && (
        <div
          className={`editor-working-banner editor-working-banner-${workingSaveStatus}`}
          role="status"
          data-testid="editor-working-banner"
        >
          <span className="editor-working-banner-icon" aria-hidden>
            {workingSaveStatus === 'error' ? '⚠' : workingSaveStatus === 'saving' ? '…' : '✓'}
          </span>
          <span>
            {workingSaveStatus === 'saving' && 'Saving working copy…'}
            {workingSaveStatus === 'saved' && !workingDirty && 'Working copy saved.'}
            {workingSaveStatus === 'error' && (
              <>
                <b>Couldn't save working copy:</b> {workingSaveError ?? 'unknown error'}
              </>
            )}
            {workingSaveStatus === 'idle' && workingDirty && 'Working copy — unsaved edits.'}
            {workingSaveStatus === 'saved' && workingDirty && 'Working copy — unsaved edits.'}
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
      <EditorActiveTab
        readOnly={readOnly}
        content={content}
        setContent={setContent}
        cmRef={cmRef}
        viewRef={viewRef}
        extensions={extensions}
        showRevisions={showRevisions}
        activeDocId={activeDocId}
        onCloseRevisions={() => setShowRevisions(false)}
        fetchStatus={fetchStatus}
        fetchError={fetchError}
        saveStatus={saveStatus}
        saveError={saveError}
      />
    </section>
  )
}

/** Renders the active editor tab's left-pane content. The tabs strip
 *  itself lives in AppLayout via <EditorTabsBar /> so it can span the
 *  full width above both editor + preview. Persistence + visibility
 *  rules are shared with the strip through useEditorTabs(). */
function EditorActiveTab(props: {
  readOnly: boolean
  content: string
  setContent: (next: string) => void
  cmRef: React.RefObject<ReactCodeMirrorRef>
  viewRef: React.MutableRefObject<EditorView | null>
  extensions: unknown[]
  showRevisions: boolean
  activeDocId: string | number | null
  onCloseRevisions: () => void
  fetchStatus: string
  fetchError: string | null | undefined
  saveStatus: string
  saveError: string | null | undefined
}) {
  const { activeTab, flistTabsVisible } = useEditorTabs()
  const flistActiveId = useStore((s) => s.flistActiveCharacterId)

  if (flistTabsVisible && flistActiveId) {
    if (activeTab === 'profile-fields') {
      return props.readOnly ? (
        <ProfileFieldsPreview />
      ) : (
        <ProfileFieldsTab characterId={flistActiveId} />
      )
    }
    if (activeTab === 'kinks') {
      return <KinksPane characterId={flistActiveId} />
    }
    if (activeTab === 'images') {
      return <ImagesTab characterId={flistActiveId} readOnly={props.readOnly} />
    }
    if (activeTab === 'diff') {
      return <DiffPane characterId={flistActiveId} />
    }
  }

  return (
    <div className="editor-tab-description" data-testid="editor-tab-description">
      {!props.readOnly && <Toolbar viewRef={props.viewRef} />}
      {props.fetchStatus === 'fetching' && (
        <div className="editor-progress" data-testid="editor-progress">
          <div className="editor-progress-bar" />
          <span>Fetching profile from F-list…</span>
        </div>
      )}
      {props.fetchStatus === 'error' && (
        <div className="editor-error">Couldn't fetch: {props.fetchError}</div>
      )}
      {props.saveStatus === 'error' && (
        <div className="editor-error">Couldn't save: {props.saveError}</div>
      )}
      <div className="editor-cm-row">
        <div className="editor-cm" data-testid="editor-cm">
          <CodeMirror
            ref={props.cmRef}
            value={props.content}
            theme="dark"
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            extensions={props.extensions as any}
            basicSetup={{
              lineNumbers: false,
              foldGutter: false,
              highlightActiveLine: false,
              highlightActiveLineGutter: false,
              indentOnInput: false
            }}
            onChange={(value) => props.setContent(value)}
            onCreateEditor={(view) => {
              props.viewRef.current = view
            }}
          />
        </div>
        {props.showRevisions && props.activeDocId !== null && (
          <RevisionsPanel
            docId={props.activeDocId as number}
            onClose={props.onCloseRevisions}
          />
        )}
      </div>
    </div>
  )
}
