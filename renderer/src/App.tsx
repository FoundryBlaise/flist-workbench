import { AppLayout } from './components/AppLayout'

declare global {
  interface Window {
    workbench?: { sidecarUrl: string }
  }
}

export function App() {
  return <AppLayout />
}
