import { useEffect } from 'react'
import { useStore } from '../../state'
import { CharacterPicker } from './CharacterPicker'
import { ModeToggle } from './ModeToggle'
import { PartnerList } from './PartnerList'
import { DocumentList, useEnsureDocumentsLoaded } from './DocumentList'
import { ActiveFlistChip } from '../flist/ActiveFlistChip'
import { FlistCharacterZone } from '../flist/FlistCharacterZone'

export function Sidebar() {
  const status = useStore((s) => s.charactersStatus)
  const loadCharacters = useStore((s) => s.loadCharacters)
  const mode = useStore((s) => s.mode)
  const flistActive = useStore((s) => s.flistSession.active)
  const flistRosterStatus = useStore((s) => s.flistRosterStatus)
  const loadFlistRoster = useStore((s) => s.flistLoadRoster)
  const refreshSession = useStore((s) => s.flistRefreshSession)

  useEffect(() => {
    if (status === 'idle') void loadCharacters()
  }, [status, loadCharacters])

  // First mount → ask the sidecar whether a session is already live
  // (the user may have signed in earlier in this sidecar process).
  // After the answer arrives, populate the roster if signed in.
  useEffect(() => {
    void refreshSession()
  }, [refreshSession])

  useEffect(() => {
    if (flistActive && flistRosterStatus === 'idle') {
      void loadFlistRoster()
    }
  }, [flistActive, flistRosterStatus, loadFlistRoster])

  useEnsureDocumentsLoaded()

  return (
    <aside className="sidebar" data-testid="sidebar">
      {/* F-list account chip sits above the F-Chat-log character
          picker. Two rosters intentionally — see PHASE7_TIER1_PLAN.md
          "Two rosters". Labels distinguish them. */}
      <div className="sb-section-h">F-list account</div>
      <ActiveFlistChip />
      <div className="sb-section-h">Active character (logs)</div>
      <CharacterPicker />
      <ModeToggle />
      {mode === 'editor' ? (
        <>
          <FlistCharacterZone />
          <div className="sb-section-h">Documents</div>
          <DocumentList />
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
