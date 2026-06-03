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
      saveFileDialog?: (opts?: {
        title?: string
        defaultPath?: string
        filters?: { name: string; extensions: string[] }[]
      }) => Promise<string | null>
      openFileDialog?: (opts?: {
        title?: string
        defaultPath?: string
        filters?: { name: string; extensions: string[] }[]
      }) => Promise<string | null>
      readFile?: (filePath: string) => Promise<Uint8Array | null>
      writeFile?: (filePath: string, bytes: Uint8Array) => Promise<boolean>
      onMenuAction?: (listener: (action: MenuAction) => void) => () => void
      setMenuState?: (flags: {
        classifyCurrent: boolean
        classifyCharacter: boolean
        flistSessionActive: boolean
      }) => void
      openExternal?: (url: string) => void
      spawnPowerShell?: (command: string) => void
      openSettings?: () => void
    }
  }
}

export function App() {
  return <AppLayout />
}
