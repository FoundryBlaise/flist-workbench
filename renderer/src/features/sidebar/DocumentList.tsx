import { useStore } from '../../state'

export function DocumentList() {
  const activeChar = useStore((s) => s.activeCharacter)
  if (!activeChar) return <div className="sb-empty">Pick a character first.</div>
  return (
    <div className="sb-empty" data-testid="document-list">
      Local document store lands in the next milestone.
    </div>
  )
}
