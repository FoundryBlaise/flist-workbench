import { AppLayout } from './components/AppLayout'

export type MenuAction =
  | 'mode-editor'
  | 'mode-logs'
  | 'find-contacts'
  | 'search-all-partners'
  | 'settings'
  | 'ingest-current'
  | 'ingest-character'
  | 'ingest-all'
  | 'flist-activity'
  | 'restore-userscript-help'
  | 'backup-all'
  | 'check-updates'
  | 'edit-undo'
  | 'edit-redo'

declare global {
  interface Window {
    workbench?: {
      sidecarUrl: string
      appVersion?: string
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
        ingestCurrent: boolean
        ingestCharacter: boolean
        flistSessionActive: boolean
      }) => void
      openExternal?: (url: string) => void
      fetchImageBytes?: (
        url: string
      ) => Promise<{ bytes: Uint8Array; mime: string } | null>
      openSettings?: () => void
      creds?: {
        getMeta: () => Promise<{
          account: string | null
          autoLogin: boolean
          encryptionAvailable: boolean
          hasPassword: boolean
        }>
        getPassword: () => Promise<string | null>
        save: (payload: {
          account: string
          password: string
          autoLogin: boolean
        }) => Promise<boolean>
        setAutoLogin: (next: boolean) => Promise<boolean>
        clear: () => Promise<boolean>
      }
      updater?: {
        getStatus: () => Promise<unknown>
        check: () => Promise<boolean>
        startupCheck: () => void
        download: () => Promise<boolean>
        install: () => void
        onStatus: (listener: (status: unknown) => void) => () => void
      }
    }
  }
}

export function App() {
  return <AppLayout />
}
