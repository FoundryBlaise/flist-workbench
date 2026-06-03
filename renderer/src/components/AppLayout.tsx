import { useEffect, useState } from 'react'
import { Sidebar } from '../features/sidebar/Sidebar'
import { EditorPane } from '../features/editor/EditorPane'
import { PreviewPane } from '../features/editor/PreviewPane'
import { LogViewer } from '../features/logs/LogViewer'
import { CrossSearch } from '../features/logs/CrossSearch'
import { FindContactsModal } from '../features/logs/FindContactsModal'
import { SignInModal } from '../features/flist/SignInModal'
import { ActivityLogModal } from '../features/flist/ActivityLogModal'
import { UserscriptHelpModal } from '../features/flist/UserscriptHelpModal'
import { BackupAllBanner } from '../features/flist/BackupAllBanner'
import { ExportRestoreModal } from '../features/flist/ExportRestoreModal'
import { SettingsModal } from '../features/settings/SettingsModal'
import { AISetupWizard } from '../features/setup/AISetupWizard'
import { ClassifyDialog } from '../features/labels/ClassifyDialog'
import { IngestDialog } from '../features/rag/IngestDialog'
import { ChatPanel } from '../features/rag/ChatPanel'
import { useStore } from '../state'
import { api } from '../lib/api'
import { displayPartner, displayCharacter as displayName } from '../lib/partnerName'
import type { MenuAction } from '../App'

type HealthStatus = 'checking' | 'ok' | 'error'

export function AppLayout() {
  const mode = useStore((s) => s.mode)
  const setMode = useStore((s) => s.setMode)
  const activeChar = useStore((s) => s.activeCharacter)
  const activePartner = useStore((s) => s.activePartner)
  const editorTitle = useStore((s) => s.editorTitle)
  const dirty = useStore((s) => s.editorDirty)
  const crossSearchOpen = useStore((s) => s.crossSearchOpen)
  const setCrossSearchOpen = useStore((s) => s.setCrossSearchOpen)
  const classifyTarget = useStore((s) => s.classifyTarget)
  const openClassify = useStore((s) => s.openClassify)
  const closeClassify = useStore((s) => s.closeClassify)
  const ingestTarget = useStore((s) => s.ingestTarget)
  const openIngest = useStore((s) => s.openIngest)
  const closeIngest = useStore((s) => s.closeIngest)
  const chatPanelOpen = useStore((s) => s.chatPanelOpen)
  const toggleChatPanel = useStore((s) => s.toggleChatPanel)
  const flistSignInOpen = useStore((s) => s.flistSignInOpen)
  const flistCloseSignIn = useStore((s) => s.flistCloseSignIn)
  const flistOpenSignIn = useStore((s) => s.flistOpenSignIn)
  const flistSession = useStore((s) => s.flistSession)
  const flistRoster = useStore((s) => s.flistRoster)
  const aiSetupOpen = useStore((s) => s.aiSetupOpen)
  const openAiSetup = useStore((s) => s.openAiSetup)
  const closeAiSetup = useStore((s) => s.closeAiSetup)
  const [health, setHealth] = useState<HealthStatus>('checking')
  const [contactsOpen, setContactsOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [activityOpen, setActivityOpen] = useState(false)
  const [userscriptHelpOpen, setUserscriptHelpOpen] = useState(false)
  const exportRestoreOpen = useStore((s) => s.flistExportRestoreCharacterId)
  const closeExportRestore = useStore((s) => s.flistCloseExportRestore)
  const [firstRunToast, setFirstRunToast] = useState(false)
  const [flistHintDismissed, setFlistHintDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem('workbench.flistHintDismissed') === '1'
    } catch {
      return false
    }
  })

  useEffect(() => {
    let cancelled = false
    api
      .health()
      .then(() => !cancelled && setHealth('ok'))
      .catch(() => !cancelled && setHealth('error'))
    return () => {
      cancelled = true
    }
  }, [])

  // Tier 2 made working copies persistent. On unload, hard-flush any
  // pending autosaves synchronously via fetch+keepalive so unsaved
  // edits never get stranded in the 500 ms debounce window.
  useEffect(() => {
    const onBeforeUnload = () => {
      const s = useStore.getState()
      for (const [characterId, slot] of Object.entries(s.flistWorking)) {
        // Skip slots already mid-save — a parallel keepalive PUT with a
        // stale etag would race the in-flight request and lose, or
        // worse, win and clobber it (QA P2-2). The in-flight PUT
        // already includes the user's most recent payload.
        if (!slot.unsavedDirty) continue
        if (slot.saveStatus === 'saving') continue
        try {
          const url = `${api.base()}/flist/character/${encodeURIComponent(
            characterId
          )}/working`
          const headers: Record<string, string> = {
            'Content-Type': 'application/json'
          }
          if (slot.materialised && slot.etag) headers['If-Match'] = slot.etag
          // keepalive lets the request survive the page unload — sized
          // for the typical working-copy payload (sub-100 KB), well
          // under the 64 KB hard cap on most browsers / Electron. If a
          // payload exceeds the cap we just lose the in-flight save;
          // the next open re-presents an unsaved-dirty banner.
          fetch(url, {
            method: 'PUT',
            headers,
            body: JSON.stringify(slot.payload),
            keepalive: true
          }).catch(() => {})
        } catch {
          // best-effort
        }
      }
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  // First-run detection: surface a non-blocking toast pointing at AI
  // Setup when there's nothing indexed and no labels endpoint override.
  // Less hostile than auto-opening the wizard; the user can dismiss
  // permanently or click through. Runs once on mount per session.
  useEffect(() => {
    let cancelled = false
    const KEY = 'workbench.firstRunDismissed'
    try {
      if (localStorage.getItem(KEY) === '1') return
    } catch {
      // localStorage unavailable — fall through and just suppress next session.
    }
    void (async () => {
      try {
        const [s, rag] = await Promise.all([api.settingsGet(), api.ragStatus()])
        if (cancelled) return
        const labelsDefault =
          s.labels.llm_endpoint === s.labels.defaults.llm_endpoint
        const ragDefault =
          s.rag.embed_endpoint === s.rag.defaults.embed_endpoint &&
          s.rag.chat_endpoint === s.rag.defaults.chat_endpoint
        if (labelsDefault && ragDefault && rag.chunk_count === 0) {
          setFirstRunToast(true)
        }
      } catch {
        // Sidecar unreachable — health card already covers that case.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const dismissFirstRun = (permanent: boolean) => {
    setFirstRunToast(false)
    if (permanent) {
      try {
        localStorage.setItem('workbench.firstRunDismissed', '1')
      } catch {
        // No-op — see read site above.
      }
    }
  }

  const dismissFlistHint = () => {
    setFlistHintDismissed(true)
    try {
      localStorage.setItem('workbench.flistHintDismissed', '1')
    } catch {
      // localStorage unavailable — accept session-only dismissal.
    }
  }

  // Show only when the user clearly hasn't found F-list integration yet:
  // not signed in, no archived characters, and they haven't dismissed it.
  // Suppressed while any modal is open (sign-in, AI setup) so we don't
  // stack toasts above modals.
  const showFlistHint =
    !flistHintDismissed
    && !flistSession.active
    && flistRoster.length === 0
    && !flistSignInOpen
    && !aiSetupOpen
    && !firstRunToast

  // Push activeChar/activePartner state to the native menu so items
  // requiring a selection grey out instead of silently no-op'ing.
  useEffect(() => {
    window.workbench?.setMenuState?.({
      classifyCurrent: !!(activeChar && activePartner),
      classifyCharacter: !!activeChar,
      flistSessionActive: !!flistSession.active
    })
  }, [activeChar, activePartner, flistSession.active])

  // Native menu (electron/menu.ts) dispatches actions over IPC. Route
  // them to the existing local/store handlers so the menu items are
  // wired without duplicating any logic.
  useEffect(() => {
    const subscribe = window.workbench?.onMenuAction
    if (!subscribe) return
    return subscribe((action: MenuAction) => {
      switch (action) {
        case 'mode-editor':
          setMode('editor')
          break
        case 'mode-logs':
          setMode('logs')
          break
        case 'find-contacts':
          setContactsOpen(true)
          break
        case 'search-all-partners':
          setCrossSearchOpen(true)
          break
        case 'settings':
          setSettingsOpen(true)
          break
        case 'classify-current':
          if (activeChar && activePartner) {
            openClassify(
              { character: activeChar, partner: activePartner },
              `${displayPartner(activePartner)} with ${displayName(activeChar)}`
            )
          }
          break
        case 'classify-character':
          if (activeChar) {
            openClassify(
              { character: activeChar },
              `All partners for ${displayName(activeChar)}`
            )
          }
          break
        case 'classify-all':
          openClassify({}, 'All characters, all partners')
          break
        case 'ingest-current':
          if (activeChar && activePartner) {
            openIngest(
              { character: activeChar, partner: activePartner },
              `${displayPartner(activePartner)} with ${displayName(activeChar)}`
            )
          }
          break
        case 'ingest-character':
          if (activeChar) {
            openIngest(
              { character: activeChar },
              `All partners for ${displayName(activeChar)}`
            )
          }
          break
        case 'ingest-all':
          openIngest({}, 'All characters, all partners')
          break
        case 'ai-setup':
          openAiSetup()
          break
        case 'flist-activity':
          setActivityOpen(true)
          break
        case 'restore-userscript-help':
          setUserscriptHelpOpen(true)
          break
        case 'chat-toggle':
          // Opening the chat panel also flips to logs mode — chat is
          // contextual to the log viewer, so launching it from the
          // editor surface should put the user where the panel lives.
          if (mode !== 'logs') setMode('logs')
          toggleChatPanel()
          break
        case 'backup-all':
          void useStore.getState().flistBackupAll()
          break
      }
    })
  }, [
    setMode,
    setCrossSearchOpen,
    activeChar,
    activePartner,
    openClassify,
    openIngest,
    toggleChatPanel,
    mode
  ])

  // The header centre piece identifies what the user is currently
  // looking at. In editor mode that's the document; in log mode it's
  // the conversation. Active character is a log-side filter and lives
  // in the sidebar — putting it here in editor mode misleads the OS
  // window switcher (taskbar reads "Auldren Nadir" while the user is
  // editing "Lady Amber Blaise.bbcode").
  const titleDoc =
    mode === 'editor'
      ? `${dirty ? '● ' : ''}${editorTitle}`
      : activePartner && activeChar
        ? `${displayPartner(activePartner)} — ${displayName(activeChar)}`
        : activeChar
          ? displayName(activeChar)
          : '—'

  useEffect(() => {
    document.title = `${titleDoc} — F-list Workbench`
  }, [titleDoc])

  return (
    <div className="app">
      <header className="titlebar">
        <span className="app-name">● F-list Workbench</span>
        <span className="title-doc" data-testid="titlebar-doc">{titleDoc}</span>
        <span
          className={`sidecar-pill sidecar-${health}`}
          data-testid="sidecar-status"
          title="Sidecar /health"
        >
          sidecar: {health}
        </span>
      </header>
      {firstRunToast && !aiSetupOpen && (
        <div
          className="first-run-toast"
          role="status"
          data-testid="first-run-toast"
        >
          <span>
            <strong>First time?</strong> Configure your local AI in{' '}
            <strong>Tools → AI Setup…</strong> before classifying or indexing.
          </span>
          <button
            type="button"
            className="first-run-toast-open"
            onClick={() => {
              openAiSetup()
              dismissFirstRun(true)
            }}
            data-testid="first-run-toast-open"
          >
            Open AI Setup
          </button>
          <button
            type="button"
            className="first-run-toast-dismiss"
            onClick={() => dismissFirstRun(true)}
            aria-label="Don't show again"
            data-testid="first-run-toast-dismiss"
            title="Don't show again"
          >
            ✕
          </button>
        </div>
      )}
      {showFlistHint && (
        <div
          className="first-run-toast"
          role="status"
          data-testid="flist-hint-toast"
        >
          <span>
            <strong>Edit your F-list profile?</strong> Sign in to pull your
            characters — the character chip in the sidebar opens the picker.
          </span>
          <button
            type="button"
            className="first-run-toast-open"
            onClick={() => {
              flistOpenSignIn()
              dismissFlistHint()
            }}
            data-testid="flist-hint-toast-open"
          >
            Sign in
          </button>
          <button
            type="button"
            className="first-run-toast-dismiss"
            onClick={dismissFlistHint}
            aria-label="Don't show again"
            data-testid="flist-hint-toast-dismiss"
            title="Don't show again"
          >
            ✕
          </button>
        </div>
      )}
      <BackupAllBanner />
      {contactsOpen && <FindContactsModal onClose={() => setContactsOpen(false)} />}
      {flistSignInOpen && <SignInModal onClose={flistCloseSignIn} />}
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {aiSetupOpen && <AISetupWizard onClose={closeAiSetup} />}
      {activityOpen && <ActivityLogModal onClose={() => setActivityOpen(false)} />}
      {userscriptHelpOpen && (
        <UserscriptHelpModal onClose={() => setUserscriptHelpOpen(false)} />
      )}
      {exportRestoreOpen && (
        <ExportRestoreModal
          characterId={exportRestoreOpen}
          onClose={closeExportRestore}
          onShowUserscriptHelp={() => {
            closeExportRestore()
            setUserscriptHelpOpen(true)
          }}
        />
      )}
      {classifyTarget && (
        <ClassifyDialog
          key={`${classifyTarget.scope.character ?? '*'}::${classifyTarget.scope.partner ?? '*'}`}
          scope={classifyTarget.scope}
          scopeLabel={classifyTarget.label}
          onClose={closeClassify}
        />
      )}
      {ingestTarget && (
        <IngestDialog
          key={`ingest::${ingestTarget.forceRewipe ? 'wipe' : 'add'}::${ingestTarget.scope.character ?? '*'}::${ingestTarget.scope.partner ?? '*'}`}
          scope={ingestTarget.scope}
          scopeLabel={ingestTarget.label}
          forceRewipe={ingestTarget.forceRewipe}
          onClose={closeIngest}
        />
      )}
      <main
        className={`main main-${mode}${
          mode === 'logs' && chatPanelOpen ? ' main-logs-with-chat' : ''
        }`}
      >
        <Sidebar />
        {mode === 'editor' ? (
          <>
            <EditorPane />
            <PreviewPane />
          </>
        ) : crossSearchOpen ? (
          <CrossSearch onClose={() => setCrossSearchOpen(false)} />
        ) : (
          <>
            <LogViewer />
            {chatPanelOpen && <ChatPanel />}
          </>
        )}
      </main>
    </div>
  )
}
