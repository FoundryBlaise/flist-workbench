import { useEffect } from 'react'
import { useStore } from '../../state'
import { UnifiedCharacterPicker } from './UnifiedCharacterPicker'
import { ModeToggle } from './ModeToggle'
import { PartnerList } from './PartnerList'
import { Tier7Pane } from './Tier7Pane'
import { FlistCharacterZone } from '../flist/FlistCharacterZone'

export function Sidebar() {
  const status = useStore((s) => s.charactersStatus)
  const loadCharacters = useStore((s) => s.loadCharacters)
  const mode = useStore((s) => s.mode)
  const refreshSession = useStore((s) => s.flistRefreshSession)

  useEffect(() => {
    if (status === 'idle') void loadCharacters()
  }, [status, loadCharacters])

  useEffect(() => {
    void refreshSession()
  }, [refreshSession])

  return (
    <aside className="sidebar" data-testid="sidebar">
      <div className="sb-section-h">Active character</div>
      <UnifiedCharacterPicker />
      <ModeToggle />
      {mode === 'editor' ? (
        <>
          <FlistCharacterZone />
          <Tier7Pane />
        </>
      ) : (
        <>
          <div className="sb-section-h">Partners</div>
          <PartnerList />
        </>
      )}
    </aside>
  )
}
