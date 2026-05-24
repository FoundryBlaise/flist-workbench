import { useStore } from '../../state'

export function DocumentList() {
  const activeChar = useStore((s) => s.activeCharacter)
  const title = useStore((s) => s.editorTitle)
  if (!activeChar) return <div className="sb-empty">Pick a character first.</div>
  return (
    <ul className="sb-list" data-testid="document-list">
      <li>
        <button type="button" className="sb-item active" title={title}>
          <span className="ic" aria-hidden>·</span>
          <span className="label">{title}</span>
        </button>
      </li>
      <li className="sb-empty">
        Saving named documents is on the roadmap.
      </li>
    </ul>
  )
}
