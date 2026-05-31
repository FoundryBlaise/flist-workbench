import { useEffect, useMemo, useRef, useState } from 'react'
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { useStore } from '../../state'
import { bbcodeExtensions } from '../../lib/bbcode/codemirror'
import { Tabs, type TabsTab } from '../../components/Tabs'
import { ProfileFieldsTab } from '../flist/ProfileFieldsTab'
import { KinksPane } from '../flist/KinksPane'
import { countKinksWithChoice } from '../flist/kinksUnified'
import { ProfileFieldsPreview } from '../flist/ProfileFieldsPreview'
import { DiffPane, countDiffChanges } from '../flist/DiffPane'
import { Toolbar } from './Toolbar'
import { RevisionsPanel } from './RevisionsPanel'

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
    s.flistActiveCharacterId ? s.flistWorking[s.flistActiveCharacterId] : undefined
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
    s.flistActiveCharacterId ? s.flistWorking[s.flistActiveCharacterId] : undefined
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
      <EditorTabsHost
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

/** Wraps the BBCode editing surface in a Tabs primitive. Tier 2 Prep
 *  registers the strip as a single-tab no-op via `hideStripOnSingle`;
 *  Main PR B adds the Profile fields tab when a working copy is active.
 *  Read-only views (Live / Backup) stay on the Description tab only.
 */
function EditorTabsHost(props: {
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
  const flistActiveId = useStore((s) => s.flistActiveCharacterId)
  // Per-character active tab — switching characters shouldn't pin the
  // user on a working-copy-only tab inherited from a different
  // character (UX P3-11). Description (BBCode) is the safe default
  // when nothing has been persisted yet.
  const tabKey = flistActiveId
    ? `flist-workbench:active-editor-tab:${flistActiveId}`
    : 'flist-workbench:active-editor-tab'
  const [activeTab, setActiveTab] = useState<string>(() => {
    try {
      return localStorage.getItem(tabKey) ?? 'description'
    } catch {
      return 'description'
    }
  })
  useEffect(() => {
    try {
      const stored = localStorage.getItem(tabKey)
      if (stored && stored !== activeTab) setActiveTab(stored)
      else if (!stored) setActiveTab('description')
    } catch {
      // ignore
    }
    // intentionally watch only tabKey — changing the key (character switch)
    // re-reads the persisted choice for the new character.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabKey])
  useEffect(() => {
    try {
      localStorage.setItem(tabKey, activeTab)
    } catch {
      // ignore
    }
  }, [activeTab, tabKey])
  const setEditorActiveTab = useStore((s) => s.setEditorActiveTab)
  useEffect(() => {
    setEditorActiveTab(activeTab)
  }, [activeTab, setEditorActiveTab])
  const activeDocIdRaw = useStore((s) => s.activeDocId)
  // The 4 F-list tabs (Description, Profile fields, Kinks, Diff) are
  // visible whenever a character is active and no doc is open — both
  // editing the working copy ("My edits") and viewing the live or a
  // backup snapshot. readOnly is no longer a visibility gate; each
  // tab handles read-only mode internally.
  const flistTabsVisible = flistActiveId !== null && activeDocIdRaw === null
  const workingCopyMode =
    flistTabsVisible && !props.readOnly
  const workingSlot = useStore((s) =>
    flistActiveId ? s.flistWorking[flistActiveId] : undefined
  )
  const kinksCount = countKinksWithChoice(workingSlot)
  const diffChangeCount = countDiffChanges(workingSlot)
  const tabs: TabsTab[] = useMemo(() => {
    const descriptionTab: TabsTab = {
      id: 'description',
      label: 'Description (BBCode)',
      content: (
        <>
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
        </>
      )
    }
    const out: TabsTab[] = [descriptionTab]
    if (flistTabsVisible && flistActiveId) {
      out.push({
        id: 'profile-fields',
        label: 'Profile fields',
        // In read-only views (Live / Backup) the editing rail/forms
        // don't apply — substitute the website-style preview, which
        // already renders a clean read-only Info pane.
        content: props.readOnly ? (
          <ProfileFieldsPreview />
        ) : (
          <ProfileFieldsTab characterId={flistActiveId} />
        )
      })
      out.push({
        id: 'kinks',
        label: 'Kinks',
        badge: kinksCount > 0 ? kinksCount : undefined,
        content: <KinksPane characterId={flistActiveId} />
      })
      out.push({
        id: 'diff',
        label: 'Diff',
        badge: diffChangeCount > 0 ? diffChangeCount : undefined,
        content: <DiffPane characterId={flistActiveId} />
      })
    }
    return out
  }, [
    props.readOnly,
    props.fetchStatus,
    props.fetchError,
    props.saveStatus,
    props.saveError,
    props.content,
    props.extensions,
    props.showRevisions,
    props.activeDocId,
    props.cmRef,
    props.viewRef,
    props.setContent,
    props.onCloseRevisions,
    flistTabsVisible,
    flistActiveId,
    kinksCount,
    diffChangeCount
  ])
  // Snap back to description only when the F-list-tab surface itself
  // is gone (no character, or a document is open). Switching between
  // My edits / From F-list / Backup should keep the user on whichever
  // tab they were on — that's the whole point of read-only tabs.
  useEffect(() => {
    if (!flistTabsVisible && activeTab !== 'description') {
      setActiveTab('description')
    }
  }, [flistTabsVisible, activeTab])
  return (
    <Tabs
      tabs={tabs}
      activeId={activeTab}
      onChange={setActiveTab}
      hideStripOnSingle
      testId="editor-tabs"
    />
  )
}
