import { useRef, useState } from 'react'
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { EditorView } from '@codemirror/view'
import { useStore } from '../../state'
import { bbcodeExtensions } from '../../lib/bbcode/codemirror'
import { Toolbar } from './Toolbar'

export function EditorPane() {
  const content = useStore((s) => s.editorContent)
  const setContent = useStore((s) => s.setEditorContent)
  const title = useStore((s) => s.editorTitle)
  const fetchStatus = useStore((s) => s.editorFetchStatus)
  const fetchError = useStore((s) => s.editorFetchError)
  const fetchProfile = useStore((s) => s.fetchProfile)
  const [fetchName, setFetchName] = useState('Azure Viper')

  const cmRef = useRef<ReactCodeMirrorRef>(null)
  const viewRef = useRef<EditorView | null>(null)

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
      <Toolbar viewRef={viewRef} />
      {fetchStatus === 'error' && (
        <div className="editor-error">Couldn't fetch: {fetchError}</div>
      )}
      <div className="editor-cm" data-testid="editor-cm">
        <CodeMirror
          ref={cmRef}
          value={content}
          theme="dark"
          extensions={bbcodeExtensions}
          basicSetup={{
            lineNumbers: false,
            foldGutter: false,
            highlightActiveLine: false,
            highlightActiveLineGutter: false,
            indentOnInput: false
          }}
          onChange={(value) => setContent(value)}
          onCreateEditor={(view) => {
            viewRef.current = view
          }}
        />
      </div>
    </section>
  )
}
