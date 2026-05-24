import { useEffect, useRef, useState } from 'react'
import { api } from '../../lib/api'
import { useStore } from '../../state'

type SettingsState = Awaited<ReturnType<typeof api.settingsGet>>

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const loadCharacters = useStore((s) => s.loadCharacters)
  const [state, setState] = useState<SettingsState | null>(null)
  const [dirInput, setDirInput] = useState('')
  const [status, setStatus] = useState<'idle' | 'loading' | 'saving' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    api
      .settingsGet()
      .then((s) => {
        if (cancelled) return
        setState(s)
        setDirInput(s.fchat_data_dir ?? '')
        setStatus('idle')
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setStatus('error')
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    const id = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [])

  const pick = async () => {
    const picker = window.workbench?.selectDirectory
    if (!picker) {
      setError("Folder picker isn't available in this build.")
      return
    }
    const chosen = await picker({
      title: 'Pick your F-Chat data directory',
      defaultPath: dirInput || state?.fchat_data_dir_effective
    })
    if (chosen) setDirInput(chosen)
  }

  const save = async (nextValue: string | null) => {
    setStatus('saving')
    setError(null)
    try {
      const updated = await api.settingsUpdate({ fchat_data_dir: nextValue })
      setState(updated)
      setDirInput(updated.fchat_data_dir ?? '')
      setStatus('idle')
      // Reload characters so the sidebar reflects the new directory
      // immediately rather than waiting for a refresh.
      await loadCharacters()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setStatus('error')
    }
  }

  const envLocked = state?.fchat_data_dir_env_locked ?? false

  return (
    <div className="modal-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h2 className="modal-title">Settings</h2>
            <p className="modal-subtitle">Where this app reads your F-Chat logs from.</p>
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="modal-body settings-body">
          <section className="settings-section">
            <label className="settings-label" htmlFor="fchat-data-dir-input">
              F-Chat data directory
            </label>
            <p className="settings-help">
              F-Chat 3.0 writes each character's logs under{' '}
              <code>&lt;data&gt;/&lt;character&gt;/logs</code>. Point this at the parent of those
              character folders.
            </p>
            <div className="settings-row">
              <input
                id="fchat-data-dir-input"
                ref={inputRef}
                type="text"
                className="settings-input"
                placeholder="/path/to/F-Chat/data"
                value={dirInput}
                onChange={(e) => setDirInput(e.target.value)}
                disabled={envLocked || status === 'saving'}
                data-testid="settings-fchat-dir-input"
              />
              <button
                type="button"
                className="settings-pick"
                onClick={() => void pick()}
                disabled={envLocked || status === 'saving' || !window.workbench?.selectDirectory}
                data-testid="settings-fchat-dir-pick"
              >
                Browse…
              </button>
            </div>
            {state && (
              <p className="settings-meta">
                Currently reading from: <code>{state.fchat_data_dir_effective}</code>
              </p>
            )}
            {envLocked && (
              <p className="settings-note">
                <b>FCHAT_DATA_DIR</b> is set in the environment and overrides this setting. Unset
                it to control the path from here.
              </p>
            )}
            {error && <p className="settings-error">{error}</p>}
            <div className="settings-actions">
              <button
                type="button"
                className="settings-save"
                onClick={() => void save(dirInput.trim() || null)}
                disabled={envLocked || status === 'saving'}
                data-testid="settings-save"
              >
                {status === 'saving' ? 'Saving…' : 'Save'}
              </button>
              {state?.fchat_data_dir && !envLocked && (
                <button
                  type="button"
                  className="settings-clear"
                  onClick={() => void save(null)}
                  disabled={status === 'saving'}
                  title="Clear the override and fall back to the default directory"
                >
                  Reset
                </button>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
