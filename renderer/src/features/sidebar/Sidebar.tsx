import { useEffect } from 'react'
import { useStore } from '../../state'
import { CharacterPicker } from './CharacterPicker'
import { ModeToggle } from './ModeToggle'
import { PartnerList } from './PartnerList'
import { DocumentList } from './DocumentList'

export function Sidebar() {
  const status = useStore((s) => s.charactersStatus)
  const loadCharacters = useStore((s) => s.loadCharacters)
  const mode = useStore((s) => s.mode)

  useEffect(() => {
    if (status === 'idle') void loadCharacters()
  }, [status, loadCharacters])

  return (
    <aside className="sidebar" data-testid="sidebar">
      <div className="sb-section-h">Active Character</div>
      <CharacterPicker />
      <ModeToggle />
      <div className="sb-section-h">{mode === 'editor' ? 'Documents' : 'Partners'}</div>
      {mode === 'editor' ? <DocumentList /> : <PartnerList />}
    </aside>
  )
}
