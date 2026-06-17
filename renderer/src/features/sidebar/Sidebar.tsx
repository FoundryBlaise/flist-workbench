import { useEffect } from 'react'
import { useStore } from '../../state'
import { UnifiedCharacterPicker } from './UnifiedCharacterPicker'
import { ModeToggle } from './ModeToggle'
import { PartnerList } from './PartnerList'
import { FlistCharacterZone } from '../flist/FlistCharacterZone'
import { BackupsList } from './BackupsList'

export function Sidebar() {
  const status = useStore((s) => s.charactersStatus)
  const loadCharacters = useStore((s) => s.loadCharacters)
  const mode = useStore((s) => s.mode)
  const refreshSession = useStore((s) => s.flistRefreshSession)

  useEffect(() => {
    if (status === 'idle') void loadCharacters()
  }, [status, loadCharacters])

  // Probe whether a sidecar-side session already exists (e.g. user
  // signed in earlier in this sidecar process, then the renderer
  // reloaded). The unified picker handles roster loading on its own.
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
          <BackupsList />
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
