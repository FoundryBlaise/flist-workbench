import { useEffect, useState } from 'react'

type Status = 'checking' | 'ok' | 'error'

declare global {
  interface Window {
    workbench: { sidecarUrl: string }
  }
}

export function App() {
  const [status, setStatus] = useState<Status>('checking')
  const [detail, setDetail] = useState<string>('')

  useEffect(() => {
    const url = `${window.workbench.sidecarUrl}/health`
    fetch(url)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body = (await res.json()) as Record<string, unknown>
        setStatus('ok')
        setDetail(JSON.stringify(body))
      })
      .catch((err: unknown) => {
        setStatus('error')
        setDetail(err instanceof Error ? err.message : String(err))
      })
  }, [])

  return (
    <main className="app">
      <h1>F-list Workbench</h1>
      <p className="sub">Phase 0 scaffold &mdash; the editor and log browser come later.</p>
      <div className={`status status-${status}`} data-testid="sidecar-status">
        Sidecar: <strong>{status}</strong>
        {detail && <span className="detail"> &middot; {detail}</span>}
      </div>
    </main>
  )
}
