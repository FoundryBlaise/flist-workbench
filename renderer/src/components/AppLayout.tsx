import { useEffect, useState } from 'react'
import { Sidebar } from '../features/sidebar/Sidebar'
import { EditorPane } from '../features/editor/EditorPane'
import { PreviewPane } from '../features/editor/PreviewPane'
import { LogViewer } from '../features/logs/LogViewer'
import { CrossSearch } from '../features/logs/CrossSearch'
import { FindContactsModal } from '../features/logs/FindContactsModal'
import { SettingsModal } from '../features/settings/SettingsModal'
import { ClassifyDialog } from '../features/labels/ClassifyDialog'
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
  const [health, setHealth] = useState<HealthStatus>('checking')
  const [contactsOpen, setContactsOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

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
      }
    })
  }, [setMode, setCrossSearchOpen, activeChar, activePartner, openClassify])

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
      {contactsOpen && <FindContactsModal onClose={() => setContactsOpen(false)} />}
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {classifyTarget && (
        <ClassifyDialog
          key={`${classifyTarget.scope.character ?? '*'}::${classifyTarget.scope.partner ?? '*'}`}
          scope={classifyTarget.scope}
          scopeLabel={classifyTarget.label}
          onClose={closeClassify}
        />
      )}
      <main className={`main main-${mode}`}>
        <Sidebar />
        {mode === 'editor' ? (
          <>
            <EditorPane />
            <PreviewPane />
          </>
        ) : crossSearchOpen ? (
          <CrossSearch onClose={() => setCrossSearchOpen(false)} />
        ) : (
          <LogViewer />
        )}
      </main>
    </div>
  )
}
