import { AppLayout } from './components/AppLayout'

export type MenuAction =
  | 'mode-editor'
  | 'mode-logs'
  | 'find-contacts'
  | 'search-all-partners'
  | 'settings'
  | 'classify-current'
  | 'classify-character'
  | 'classify-all'
  | 'ingest-current'
  | 'ingest-character'
  | 'ingest-all'
  | 'chat-toggle'
  | 'ai-setup'
  | 'flist-activity'
  | 'restore-userscript-help'

declare global {
  interface Window {
    workbench?: {
      sidecarUrl: string
      selectDirectory?: (opts?: {
        title?: string
        defaultPath?: string
      }) => Promise<string | null>
      onMenuAction?: (listener: (action: MenuAction) => void) => () => void
      setMenuState?: (flags: { classifyCurrent: boolean; classifyCharacter: boolean }) => void
      openExternal?: (url: string) => void
      spawnPowerShell?: (command: string) => void
      openSettings?: () => void
    }
  }
}

export function App() {
  return <AppLayout />
}
