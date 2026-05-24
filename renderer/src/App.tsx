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

declare global {
  interface Window {
    workbench?: {
      sidecarUrl: string
      selectDirectory?: (opts?: {
        title?: string
        defaultPath?: string
      }) => Promise<string | null>
      onMenuAction?: (listener: (action: MenuAction) => void) => () => void
    }
  }
}

export function App() {
  return <AppLayout />
}
