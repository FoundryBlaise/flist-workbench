import { useState } from 'react'
import { useStore } from '../../state'

export function EditorPane() {
  const content = useStore((s) => s.editorContent)
  const setContent = useStore((s) => s.setEditorContent)
  const title = useStore((s) => s.editorTitle)
  const fetchStatus = useStore((s) => s.editorFetchStatus)
  const fetchError = useStore((s) => s.editorFetchError)
  const fetchProfile = useStore((s) => s.fetchProfile)
  const [fetchName, setFetchName] = useState('Azure Viper')

  return (
    <section className="pane editor-pane" data-testid="editor-pane">
      <header className="pane-head editor-head">
        <span className="doc-name">{title}</span>
        <span className="editor-meta">{content.length} chars</span>
        <form
          className="profile-fetch"
          onSubmit={(e) => {
            e.preventDefault()
            if (fetchName.trim()) void fetchProfile(fetchName.trim())
          }}
        >
          <input
            type="text"
            placeholder="Character name…"
            value={fetchName}
            onChange={(e) => setFetchName(e.target.value)}
            data-testid="profile-fetch-input"
          />
          <button type="submit" disabled={fetchStatus === 'fetching'}>
            {fetchStatus === 'fetching' ? 'Fetching…' : 'Fetch profile'}
          </button>
        </form>
      </header>
      {fetchStatus === 'error' && (
        <div className="editor-error">Couldn't fetch: {fetchError}</div>
      )}
      <textarea
        className="editor-textarea"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        spellCheck={false}
        data-testid="editor-textarea"
      />
    </section>
  )
}
