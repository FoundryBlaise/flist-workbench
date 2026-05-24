import { AppLayout } from './components/AppLayout'

declare global {
  interface Window {
    workbench?: {
      sidecarUrl: string
      selectDirectory?: (opts?: {
        title?: string
        defaultPath?: string
      }) => Promise<string | null>
    }
  }
}

export function App() {
  return <AppLayout />
}
