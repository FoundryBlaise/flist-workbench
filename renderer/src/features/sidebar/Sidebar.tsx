import { useEffect } from 'react'
import { useStore } from '../../state'
import { CharacterPicker } from './CharacterPicker'
import { ModeToggle } from './ModeToggle'
import { PartnerList } from './PartnerList'
import { DocumentList, useEnsureDocumentsLoaded } from './DocumentList'

function SearchAllButton() {
  const open = useStore((s) => s.crossSearchOpen)
  const set = useStore((s) => s.setCrossSearchOpen)
  const activeChar = useStore((s) => s.activeCharacter)
  return (
    <button
      type="button"
      className={`sb-search-all ${open ? 'on' : ''}`}
      onClick={() => set(!open)}
      disabled={!activeChar}
      title="Search across every partner log for the active character"
      data-testid="search-all-toggle"
    >
      Search all partners…
    </button>
  )
}

export function Sidebar() {
  const status = useStore((s) => s.charactersStatus)
  const loadCharacters = useStore((s) => s.loadCharacters)
  const mode = useStore((s) => s.mode)

  useEffect(() => {
    if (status === 'idle') void loadCharacters()
  }, [status, loadCharacters])

  useEnsureDocumentsLoaded()

  return (
    <aside className="sidebar" data-testid="sidebar">
      {mode === 'editor' ? (
        // In editor mode the document library is the primary control;
        // the active-character picker only feeds log filtering so it
        // collapses out of the way (still toggleable via the mode
        // switch below).
        <>
          <div className="sb-section-h">Documents</div>
          <DocumentList />
          <ModeToggle />
        </>
      ) : (
        <>
          <div className="sb-section-h">Active Character</div>
          <CharacterPicker />
          <ModeToggle />
          <SearchAllButton />
          <div className="sb-section-h">Partners</div>
          <PartnerList />
        </>
      )}
    </aside>
  )
}
