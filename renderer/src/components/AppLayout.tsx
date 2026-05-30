import { useEffect, useState } from 'react'
import { Sidebar } from '../features/sidebar/Sidebar'
import { EditorPane } from '../features/editor/EditorPane'
import { PreviewPane } from '../features/editor/PreviewPane'
import { LogViewer } from '../features/logs/LogViewer'
import { CrossSearch } from '../features/logs/CrossSearch'
import { FindContactsModal } from '../features/logs/FindContactsModal'
import { SignInModal } from '../features/flist/SignInModal'
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
  const [health, setHealth] = useState<HealthStatus>('checking')
  const [contactsOpen, setContactsOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [aiSetupOpen, setAiSetupOpen] = useState(false)
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

  // Working copies are in-memory only in Tier 1. Warn the user before
  // unload if any per-character working slot has unsaved edits, or if
  // the local-document editor has uncommitted changes. The native
  // browser prompt is the closest we get to a "you'll lose work"
  // confirm without IPC plumbing into the Electron main process; in
  // Electron it fires when the window's close button is clicked.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const s = useStore.getState()
      const anyWorkingDirty = Object.values(s.flistWorking).some(
        (w) => w.dirty
      )
      // Local-doc editor dirtiness is already covered by the autosave
      // draft slot (crash-safety), so don't double-prompt — only the
      // working-copy case is genuinely lossy on close.
      if (anyWorkingDirty) {
        e.preventDefault()
        e.returnValue = ''
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
      classifyCharacter: !!activeChar
    })
  }, [activeChar, activePartner])

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
          setAiSetupOpen(true)
          break
        case 'chat-toggle':
          // Opening the chat panel also flips to logs mode — chat is
          // contextual to the log viewer, so launching it from the
          // editor surface should put the user where the panel lives.
          if (mode !== 'logs') setMode('logs')
          toggleChatPanel()
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
              setAiSetupOpen(true)
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
      {contactsOpen && <FindContactsModal onClose={() => setContactsOpen(false)} />}
      {flistSignInOpen && <SignInModal onClose={flistCloseSignIn} />}
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {aiSetupOpen && <AISetupWizard onClose={() => setAiSetupOpen(false)} />}
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
