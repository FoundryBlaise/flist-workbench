import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { useEffect, useMemo, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { bbcodeExtensions } from '../../lib/bbcode/codemirror'

// Module-level CM state cache per kink id. Per Tier 3 plan §Step 2 +
// §R-5: cleared on character switch via `purgeCMStates`. Memory growth
// for N kinks × ~1 KB state each is well within budget; no LRU.
const _cmStateById = new Map<string, EditorState>()

export function purgeCMStates(): void {
  _cmStateById.clear()
}

// F-list serves descriptions with literal CRLF / CR — normalise on read
// so the editor doesn't render doubled blank lines (QA P3-1).
function normaliseNewlines(s: string): string {
  return s.replace(/\r\n?/g, '\n')
}

// Trimmed BBCode editor for per-kink descriptions. No revisions panel,
// no fetch input, no draft chip — the working copy IS the source of
// truth, and the surrounding flush logic handles persistence.
export function KinkDescriptionEditor({
  kinkId,
  value,
  onChange,
  readOnly
}: {
  kinkId: string
  value: string
  onChange: (next: string) => void
  readOnly?: boolean
}) {
  const cmRef = useRef<ReactCodeMirrorRef>(null)
  const extensions = useMemo(
    () =>
      readOnly
        ? [...bbcodeExtensions, EditorView.editable.of(false), EditorState.readOnly.of(true)]
        : bbcodeExtensions,
    [readOnly]
  )
  const normalised = useMemo(() => normaliseNewlines(value), [value])
  // Persist CM state on unmount so a future remount of the same kink
  // restores cursor + undo history (QA P1-3 / Tier 3 plan §Step 2).
  useEffect(
    () => () => {
      const view = cmRef.current?.view
      if (view) _cmStateById.set(kinkId, view.state)
    },
    [kinkId]
  )
  const initialState = useMemo(() => {
    const cached = _cmStateById.get(kinkId)
    return cached ? { json: cached.toJSON(), fields: undefined } : undefined
  }, [kinkId])
  return (
    <div className="kink-desc-editor" data-testid={`kink-desc-editor-${kinkId}`}>
      <CodeMirror
        ref={cmRef}
        // Re-mount when the kink id changes so the cached state is
        // restored cleanly (React's identity rule for CM swap).
        key={kinkId}
        value={normalised}
        initialState={initialState}
        theme="dark"
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        extensions={extensions as any}
        basicSetup={{
          lineNumbers: false,
          foldGutter: false,
          highlightActiveLine: false,
          highlightActiveLineGutter: false,
          indentOnInput: false
        }}
        onChange={onChange}
      />
    </div>
  )
}
