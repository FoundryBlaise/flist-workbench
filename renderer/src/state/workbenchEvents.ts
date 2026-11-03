// What the window re-reads when the sidecar announces a change it did
// not make. A model connected over MCP writes the same Workbench, labels
// the same logs and makes Backups; the paired extension backs up and
// pulls around an Upload; the app's own maintenance passes (gallery
// repair after a pull, image-id folding when the Images tab lists
// files) mark themselves internal:*. Without this the window shows a
// stale draft and then autosaves it back over the other writer's work.

import type { WorkbenchEvent } from '../lib/eventStream'

/** The store actions an event can set off; the store itself fits. */
export type WorkbenchEventTargets = {
  activeCharacter: string | null
  activePartner: string | null
  flistNoteExternalChange: (
    characterId: string,
    change: { etag: string | null; origin: string }
  ) => void
  flistLoadWorkbenchInfo: (characterId: string) => Promise<void>
  flistLoadArchive: (characterId: string) => Promise<void>
  flistLoadCharacterImages: (characterId: string) => Promise<void>
  flistLoadBackups: (characterId: string) => Promise<void>
  flistLoadRoster: () => Promise<void>
  invalidateMessages: (char: string, partner: string) => void
  loadMessages: (char: string, partner: string, opts?: { force?: boolean }) => Promise<void>
  noteIndexChanged: () => void
  noteLabelsChanged: () => void
  noteSettingsChanged: (fields: string[]) => void
}

export function applyWorkbenchEvent(event: WorkbenchEvent, store: WorkbenchEventTargets): void {
  // Our own writes come back too; nothing to do about those.
  if (event.origin === 'ui') return
  const id = event.character_id
  switch (event.event) {
    case 'set-payload-changed':
      if (id) store.flistNoteExternalChange(id, { etag: event.etag ?? null, origin: event.origin })
      break
    case 'sets-changed':
      // The Workbench's metadata moved: its row's "last changed".
      // Which row the window shows is its own choice and does not
      // follow anything on disk.
      if (id) void store.flistLoadWorkbenchInfo(id)
      break
    case 'live-changed':
      // Live, and the roster row's badge saying whether that Pull got
      // every image.
      if (id) {
        void store.flistLoadArchive(id)
        void store.flistLoadRoster()
      }
      break
    case 'images-changed':
      // Files came into or left the pool; no payload changed, so
      // nothing else would make the Images tab (or its Trash) list them.
      if (id) void store.flistLoadCharacterImages(id)
      break
    case 'backups-changed':
      // The Backup list, and the Trash view that lists deleted Backups
      // and re-reads whenever the pool does.
      if (id) {
        void store.flistLoadBackups(id)
        void store.flistLoadCharacterImages(id)
      }
      break
    case 'characters-changed':
      void store.flistLoadRoster()
      break
    case 'index-changed':
      // An ingest started or ended, or the Index was wiped: views
      // showing its status read it again.
      store.noteIndexChanged()
      break
    case 'labels-changed': {
      // Cleared Labels go to the Trash, which Settings → Labels and
      // the character's Trash view list.
      store.noteLabelsChanged()
      // Label chips are rendered from the cached message list, so
      // the cache has to go before they can refresh.
      const char = store.activeCharacter
      const partner = store.activePartner
      if (char && partner) {
        store.invalidateMessages(char, partner)
        void store.loadMessages(char, partner, { force: true })
      }
      break
    }
    case 'settings-changed':
      // A model changed settings; an open Settings and the open
      // Log (the OOC threshold) pick them up.
      store.noteSettingsChanged(Object.keys(event.changed ?? {}))
      break
    default:
      break
  }
}
