import { useMemo } from 'react'
import { useStore } from '../../state'
import { bbcodeToHtml } from '../../lib/bbcode'

export function PreviewPane() {
  const content = useStore((s) => s.editorContent)
  const html = useMemo(() => bbcodeToHtml(content), [content])
  return (
    <section className="pane preview" data-testid="preview-pane">
      <header className="pane-head">Live Preview</header>
      <div
        className="pane-body preview-body"
        data-testid="preview-body"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </section>
  )
}
