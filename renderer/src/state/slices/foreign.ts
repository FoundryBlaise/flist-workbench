// The Foreign slice: the Foreign profile slot, opened to read somebody
// else's profile, refreshed from F-list, left and emptied, with how old
// the cached copy is.
//
// Read-only, in-memory, and pointedly not a character. None of these
// actions touch flistActiveCharacterId, flistWorking or flistArchive,
// which is what keeps every copy/backup/export path from having
// anything to act on.

import { api, errorDetail, refusalCode, type ForeignProfilePayload } from '../../lib/api'
import type { SliceCreator } from './slice'

export type ForeignState = {
  /** The "Foreign profile" slot: a stand-in character the picker
   *  offers alongside the real ones. Selecting it puts the editor
   *  panel into a read-only state showing somebody else's profile.
   *
   *  It is a slot, not a character. It has no id, no archive entry, no
   *  Workbench and no `flistActiveCharacterId` — which is exactly
   *  what stops every edit, pull, backup and export path from finding
   *  anything to act on. The slot itself is not persisted: it lives in
   *  memory for as long as the app runs and is never written to the
   *  character archive. The sidecar's Foreign profile cache keeps the
   *  profile on disk until its size cap evicts it. */
  foreignActive: boolean
  foreignName: string | null
  foreignProfile: ForeignProfilePayload | null
  foreignFromCache: boolean
  foreignAgeSec: number | null
  /** Set when a refresh failed and the cached copy is being shown. */
  foreignStale: boolean
  foreignRefreshError: string | null
  foreignStatus: 'idle' | 'loading' | 'ready' | 'error'
  foreignError: string | null
}

export type ForeignSlice = ForeignState & {
  /** Select the Foreign slot. Leaves the real active character alone
   *  so going back to it restores exactly what was open. */
  foreignOpenSlot: () => void
  /** Leave the Foreign slot without clearing what it holds. */
  foreignLeaveSlot: () => void
  /** Fetch (or re-fetch) a foreign profile into the slot. */
  foreignLoad: (name: string, refresh?: boolean) => Promise<void>
  /** Drop the loaded profile, back to the lookup form. */
  foreignUnload: () => void
}

/** What the slot holds when nothing is loaded into it. */
function emptySlot(): Omit<ForeignState, 'foreignActive'> {
  return {
    foreignName: null,
    foreignProfile: null,
    foreignFromCache: false,
    foreignAgeSec: null,
    foreignStale: false,
    foreignRefreshError: null,
    foreignStatus: 'idle',
    foreignError: null
  }
}

/** The Foreign slot as the window starts: empty and not selected. */
export function foreignInitialState(): ForeignState {
  return { foreignActive: false, ...emptySlot() }
}

// Request token for foreignLoad: the number of the newest load. Picking
// profiles quickly leaves several reads in flight, landing in any
// order; only the newest may apply its answer, so the view always ends
// on the profile the user picked last. foreignUnload bumps it as well.
let _foreignLoadToken = 0

export const createForeignSlice: SliceCreator<ForeignSlice> = (set, get) => ({
  ...foreignInitialState(),

  foreignOpenSlot() {
    set({ foreignActive: true })
    // The editor pane shows the slot; leaving Logs closes cross search.
    get().setMode('editor')
  },

  foreignLeaveSlot() {
    set({ foreignActive: false })
  },

  foreignUnload() {
    // Emptying the slot is a newer pick too: a read still in flight
    // must not fill it again.
    _foreignLoadToken++
    set(emptySlot())
  },

  async foreignLoad(name, refresh = false) {
    const clean = name.trim()
    if (!clean) return
    const token = ++_foreignLoadToken
    set({ foreignStatus: 'loading', foreignError: null, foreignActive: true })
    try {
      const res = await api.foreignProfile(clean, refresh)
      if (token !== _foreignLoadToken) return
      set({
        foreignName: res.name,
        foreignProfile: res.profile,
        foreignFromCache: res.from_cache,
        foreignAgeSec: res.age_sec,
        foreignStale: res.stale === true,
        foreignRefreshError: res.refresh_error ?? null,
        foreignStatus: 'ready',
        foreignError: null
      })
    } catch (err) {
      if (token !== _foreignLoadToken) return
      // The sidecar answers these with a code so the window can say
      // something useful instead of echoing an HTTP status at someone
      // who mistyped a name.
      // Any other code (flist_server_error, flist_unreachable, ...)
      // already comes with the sidecar's own words.
      const code = refusalCode(err)
      const worded: Record<string, string> = {
        not_found:
          `F-list will not show "${clean}": there is no character by that name, ` +
          'or it was deleted, is private or blocks your account.',
        rate_limited: 'F-list is rate-limiting us. Give it a minute and try again.',
        not_signed_in: 'Your F-list session expired. Sign in again to look up profiles.'
      }
      const message = (code && worded[code]) || errorDetail(err)
      set({ foreignStatus: 'error', foreignError: message })
    }
  }
})
