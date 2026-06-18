import { useMemo, useRef } from 'react'
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

function formatKindLabel(kind: string): string {
  switch (kind) {
    case 'manual_single':
      return 'Manual'
    case 'manual_bulk':
      return 'Manual (bulk)'
    case 'import':
      return 'Import'
    case 'scheduled':
      return 'Scheduled'
    default:
      return 'Unknown'
  }
}

export function EditorPane({
  viewRef
}: {
  viewRef: React.MutableRefObject<EditorView | null>
}) {
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
  const workingCopyMode = flistActiveId !== null && !readOnly
  const workingSaveStatus = workingCopyMode
    ? flistWorkingForActive?.saveStatus ?? 'idle'
    : 'idle'
  const workingSaveError = workingCopyMode
    ? flistWorkingForActive?.saveError ?? null
    : null
  const workingDirty = workingCopyMode && !!flistWorkingForActive?.unsavedDirty
  const isLogsOnly =
    flistActiveId === null &&
    !readOnly &&
    flistActiveRosterEntry !== null &&
    !flistActiveRosterEntry.on_account

  // Browse-backup banner: when set, the editor + preview pane are
  // rendering this backup (hijacking the Live-view path so the
  // F-list profile-card chrome + inline-image resolution + theme
  // come along for free). The banner is the user's only cue that
  // they're not on their real Live data.
  const browseBackup = useStore((s) => s.flistBrowseBackup)
  const closeBrowseBackup = useStore((s) => s.flistCloseBrowseBackup)
  // Pull the user-set name (or null) from the archive's zipBackups
  // list — rename mutates that list, so the banner re-renders
  // automatically when the user picks a new name.
  const browseBackupName = useStore((s) => {
    if (!s.flistBrowseBackup) return null
    const arch = s.flistArchive[s.flistBrowseBackup.characterId]
    if (!arch?.zipBackups) return null
    const row = arch.zipBackups.find(
      (b) => b.filename === s.flistBrowseBackup!.filename
    )
    return row?.name ?? null
  })

  const cmRef = useRef<ReactCodeMirrorRef>(null)

  const extensions = useMemo(
    () =>
      readOnly
        ? [...bbcodeExtensions, EditorView.editable.of(false), EditorState.readOnly.of(true)]
        : bbcodeExtensions,
    [readOnly]
  )

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
      </header>
      {browseBackup && (
        <div
          className="editor-browse-backup-banner"
          role="status"
          data-testid="editor-browse-backup-banner"
        >
          <span className="editor-browse-backup-icon" aria-hidden>
            📦
          </span>
          <span className="editor-browse-backup-text">
            <b>Viewing backup</b>
            {browseBackupName ? ` · ${browseBackupName}` : ''}
            {browseBackup.dateLabel ? ` · ${browseBackup.dateLabel}` : ''}
            {browseBackup.kind && browseBackup.kind !== 'unknown'
              ? ` · ${formatKindLabel(browseBackup.kind)}`
              : ''}
            {' — read-only'}
          </span>
          <button
            type="button"
            className="editor-browse-backup-close"
            onClick={() => closeBrowseBackup()}
            title="Return to your live working copy"
          >
            Back to working copy
          </button>
        </div>
      )}
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
      <EditorActiveTabBody
        readOnly={readOnly}
        content={content}
        setContent={setContent}
        cmRef={cmRef}
        viewRef={viewRef}
        extensions={extensions}
        fetchStatus={fetchStatus}
        fetchError={fetchError}
        saveStatus={saveStatus}
        saveError={saveError}
        flistActiveId={flistActiveId}
      />
    </section>
  )
}

/** Renders the active editor tab's body content inside the editor
 *  pane. The tabs strip itself and the BBCode toolbar both live in
 *  AppLayout (above the editor + preview row), so they span full
 *  width. This component reads the active tab from the store and
 *  dispatches to the right component. */
function EditorActiveTabBody(props: {
  readOnly: boolean
  content: string
  setContent: (next: string) => void
  cmRef: React.RefObject<ReactCodeMirrorRef>
  viewRef: React.MutableRefObject<EditorView | null>
  extensions: unknown[]
  fetchStatus: string
  fetchError: string | null | undefined
  saveStatus: string
  saveError: string | null | undefined
  flistActiveId: string | null
}) {
  const activeTab = useStore((s) => s.editorActiveTab)
  const flistActiveId = props.flistActiveId

  if (flistActiveId) {
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
      return (
        <ImagesTab characterId={flistActiveId} readOnly={props.readOnly} />
      )
    }
    if (activeTab === 'diff') {
      return <DiffPane characterId={flistActiveId} />
    }
  }

  if (!flistActiveId) {
    return (
      <div
        className="editor-tab-description"
        data-testid="editor-tab-description"
      >
        <div className="editor-empty" data-testid="editor-empty">
          No character selected — pick one from the sidebar.
        </div>
      </div>
    )
  }

  // Default → Description body: progress/error banners + CodeMirror.
  // The BBCode toolbar lives above the editor + preview row (in
  // AppLayout), not in here, so it always spans full width.
  return (
    <div className="editor-tab-description" data-testid="editor-tab-description">
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
      </div>
    </div>
  )
}
