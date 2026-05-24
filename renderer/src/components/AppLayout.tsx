import { useEffect, useState } from 'react'
import { Sidebar } from '../features/sidebar/Sidebar'
import { EditorPane } from '../features/editor/EditorPane'
import { PreviewPane } from '../features/editor/PreviewPane'
import { LogViewer } from '../features/logs/LogViewer'
import { CrossSearch } from '../features/logs/CrossSearch'
import { useStore } from '../state'
import { api } from '../lib/api'
import { displayPartner, displayCharacter as displayName } from '../lib/partnerName'

type HealthStatus = 'checking' | 'ok' | 'error'

export function AppLayout() {
  const mode = useStore((s) => s.mode)
  const activeChar = useStore((s) => s.activeCharacter)
  const activePartner = useStore((s) => s.activePartner)
  const editorTitle = useStore((s) => s.editorTitle)
  const dirty = useStore((s) => s.editorDirty)
  const crossSearchOpen = useStore((s) => s.crossSearchOpen)
  const setCrossSearchOpen = useStore((s) => s.setCrossSearchOpen)
  const [health, setHealth] = useState<HealthStatus>('checking')

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
