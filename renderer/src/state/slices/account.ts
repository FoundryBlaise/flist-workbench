// The Account slice: the F-list session, sign-in and sign-out, the
// saved login and auto-login, the roster and the account-wide sweep
// (sign-in's auto-refresh and Refresh all), and the mapping list read
// with the session.
//
// The sidecar holds the F-list ticket; this slice mirrors enough of it
// to render the chip and footer. Sign-out saves pending Workbench edits
// first and drops the account's Workbenches through Workbench actions.
// The saved login lives in the OS keychain behind the window's preload
// bridge (`window.workbench.creds`); outside Electron there is none.

import {
  api,
  errorDetail,
  type FlistAccountCharacter,
  type FlistRosterEntry,
  type FlistSessionStatus
} from '../../lib/api'
import { readAutoRefreshEnabled, readAutoRefreshHours } from '../../features/settings/SettingsModal'
import type { State } from '../../state'
import type { SliceCreator } from './slice'

type MappingList = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  payload: (Record<string, unknown> & { _etag: string | null; _fetched_at: number | null }) | null
  fetchedAt: number | null
  etag: string | null
  error: string | null
}

export type AccountState = {
  /** Whether the user has signed in to F-list this session. The sidecar
   *  holds the ticket; the renderer mirrors enough state to render the
   *  chip + footer. */
  flistSession: FlistSessionStatus
  /** Account-roster characters returned by the most recent sign-in. */
  flistAccountCharacters: FlistAccountCharacter[]
  /** Unified roster (account + archived + log-only) from /flist/characters. */
  flistRoster: FlistRosterEntry[]
  flistRosterStatus: 'idle' | 'loading' | 'ready' | 'error'
  /** Account-wide pull sweep status. Set while the sign-in
   *  auto-refresh or the manual "Refresh all" is walking the roster. */
  flistAccountSweepStatus: 'idle' | 'running'
  /** Cached mapping-list payload. Tier 2 fetches once on first mount of
   *  the Profile-fields tab; ↻ on the staleness chip re-fetches with
   *  force=true. Purged on sign-out. */
  flistMapping: MappingList
  /** Modal visibility for the sign-in dialog. */
  flistSignInOpen: boolean
  /** Last error from a sign-in attempt; passed verbatim from F-list per
   *  the Tier 1 decision. */
  flistSignInError: string | null
  flistSignInStatus: 'idle' | 'submitting' | 'error'
  /** Saved-credential metadata, read from the OS keychain via the
   *  Electron preload. `account` is the saved username (or null if
   *  nothing is saved). `autoLogin` indicates whether the next launch
   *  should silently attempt sign-in. `hasPassword` mirrors whether
   *  the encrypted blob exists on disk. `encryptionAvailable` reflects
   *  Electron's safeStorage availability — false means we can't save
   *  even if the user asks. */
  flistSavedCreds: {
    account: string | null
    autoLogin: boolean
    encryptionAvailable: boolean
    hasPassword: boolean
  }
  /** True while the renderer is in the middle of the startup
   *  auto-login attempt. Used to suppress the sign-in modal so it
   *  doesn't flash open before the silent sign-in completes. */
  flistAutoLoginInFlight: boolean
}

export type AccountSlice = AccountState & {
  flistOpenSignIn: () => void
  flistCloseSignIn: () => void
  flistSignIn: (
    account: string,
    password: string,
    opts?: { rememberPassword?: boolean; autoLogin?: boolean }
  ) => Promise<void>
  flistSignOut: () => Promise<void>
  /** Read saved-cred metadata from the Electron main process so the
   *  startup flow can decide between auto-login and showing the modal.
   *  Safe to call before sign-in; no-op outside Electron. */
  flistLoadSavedCreds: () => Promise<void>
  /** Try to silently sign in using saved credentials. If auto-login is
   *  on and the keychain has a password, this fires the same sign-in
   *  request the modal would. On failure, the sign-in modal opens with
   *  the error visible — saved creds are left intact. Returns `true`
   *  when an attempt was made (regardless of outcome). */
  flistAttemptAutoLogin: () => Promise<boolean>
  /** Remove the saved password + metadata from disk. Used by Settings'
   *  "Remove saved login" and triggered by Sign Out (no — Sign Out
   *  keeps the saved creds so the user can sign back in next launch). */
  flistClearSavedCreds: () => Promise<void>
  /** Toggle the auto-login flag without re-entering the password.
   *  No-op when no credentials are saved. */
  flistSetSavedAutoLogin: (next: boolean) => Promise<void>
  flistRefreshSession: () => Promise<void>
  flistLoadRoster: () => Promise<void>
  /** Manual "Refresh all" — unconditionally pulls every account
   *  character on the current roster. Single-flight: triggering while
   *  a sweep is running (either this or the sign-in sweep) is a no-op. */
  flistRefreshAllAccount: () => Promise<void>
  flistLoadMapping: (opts?: { force?: boolean }) => Promise<void>
}

function idleMapping(): MappingList {
  return { status: 'idle', payload: null, fetchedAt: null, etag: null, error: null }
}

/** The Account state as the window starts: signed out, nothing read
 *  yet. Tests reset the slice with `useStore.setState(accountInitialState())`. */
export function accountInitialState(): AccountState {
  return {
    flistSession: { active: false },
    flistAccountCharacters: [],
    flistRoster: [],
    flistRosterStatus: 'idle',
    flistAccountSweepStatus: 'idle',
    flistMapping: idleMapping(),
    flistSignInOpen: false,
    flistSignInError: null,
    flistSignInStatus: 'idle',
    flistSavedCreds: {
      account: null,
      autoLogin: false,
      encryptionAvailable: false,
      hasPassword: false
    },
    flistAutoLoginInFlight: false
  }
}

// Tracks whether an account-wide sweep is in flight. Shared between
// the sign-in auto-refresh and the picker's manual "↻ Refresh all",
// so a second trigger while one is running is a no-op rather than
// running two passes over the same characters.
let _flistAccountSweepInFlight = false

// In-flight mapping-list promise (QA P3-4): callers awaiting an
// already-running flistLoadMapping get the same promise back so they
// can sequence their work after `payload` is populated.
let _mappingInflight: Promise<void> | null = null

// Monotonic session counter bumped on sign-in / sign-out (QA P2-4).
// Mapping-list responses that arrive after a session change are
// discarded so a prior account's data can't be reinstated.
let _flistSessionEpoch = 0

/** Pull every account character on the current roster.
 *  - `thresholdSec === null` → unconditional (manual Refresh all).
 *  - `thresholdSec >= 0`     → skip characters fresher than threshold.
 *  Single-flight: a second call while a sweep is running is a no-op. */
async function _flistAccountSweep(
  get: () => State,
  set: (patch: Partial<AccountState>) => void,
  thresholdSec: number | null
): Promise<void> {
  if (_flistAccountSweepInFlight) return
  _flistAccountSweepInFlight = true
  set({ flistAccountSweepStatus: 'running' })
  try {
    const now = Date.now() / 1000
    if (!get().flistSession.active) return
    const roster = get().flistRoster
    // Snapshot the IDs we want to refresh up front — the loop below
    // awaits each pull, so by the time we get to character N the
    // roster could have changed (sign-out + sign-in).
    const targets = roster
      .filter((r) => r.on_account && r.id !== null)
      .map((r) => ({
        name: r.name,
        id: String(r.id),
        lastPulledAt: r.last_pulled_at
      }))
    for (const t of targets) {
      // Bail if the user signed out mid-sweep so we don't keep firing
      // pulls against a session that no longer exists.
      if (!get().flistSession.active) break
      // Already being pulled, and this window follows it.
      const status = get().flistArchive[t.id]?.pullStatus
      if (status === 'queued' || status === 'running') continue
      if (thresholdSec !== null) {
        const age =
          t.lastPulledAt === null
            ? Number.POSITIVE_INFINITY
            : now - t.lastPulledAt
        if (age < thresholdSec) continue
      }
      // selectCharacter would change the active character; we want
      // a silent background refresh, so go straight to the pull.
      // One Pull at a time here; a character another job holds (a
      // Pull the user started by hand, Back up all) is skipped.
      try {
        await get().flistPullCharacter(t.name, t.id, { skipWhenBusy: true })
      } catch {
        // Per-character failures are surfaced via the picker badge
        // (slot.pullError). Don't abort the rest of the sweep.
      }
    }
  } finally {
    _flistAccountSweepInFlight = false
    set({ flistAccountSweepStatus: 'idle' })
  }
}

async function _flistAutoRefreshOnLogin(
  get: () => State,
  set: (patch: Partial<AccountState>) => void
): Promise<void> {
  // User opt-in. Default off — see Settings → F-list. The 30-min
  // lazy-pull-on-select keeps the active character fresh without
  // hammering the API for every character on the account.
  if (!readAutoRefreshEnabled()) return
  const thresholdSec = readAutoRefreshHours() * 3600
  await _flistAccountSweep(get, set, thresholdSec)
}

export const createAccountSlice: SliceCreator<AccountSlice> = (set, get) => ({
  ...accountInitialState(),

  flistOpenSignIn() {
    set({ flistSignInOpen: true, flistSignInError: null, flistSignInStatus: 'idle' })
  },

  async flistLoadSavedCreds() {
    const credsApi = window.workbench?.creds
    if (!credsApi) return
    try {
      const meta = await credsApi.getMeta()
      set({ flistSavedCreds: meta })
    } catch (err) {
      console.warn('[creds] load meta failed:', err)
    }
  },

  async flistAttemptAutoLogin() {
    const credsApi = window.workbench?.creds
    if (!credsApi) return false
    const { flistSavedCreds, flistSession } = get()
    if (flistSession.active) return false
    if (!flistSavedCreds.autoLogin || !flistSavedCreds.account) return false
    set({ flistAutoLoginInFlight: true })
    try {
      const password = await credsApi.getPassword()
      if (!password) return false
      // We do NOT pass rememberPassword/autoLogin here — saved
      // creds already exist, and re-saving on every auto-login
      // would also force-rewrite the meta blob for no reason. A
      // failed auto-login surfaces via flistSignInError; the
      // saved creds stay put so the user can correct from the
      // modal without losing the username they remembered.
      await get().flistSignIn(flistSavedCreds.account, password)
      return true
    } catch (err) {
      console.warn('[creds] auto-login failed:', err)
      return false
    } finally {
      set({ flistAutoLoginInFlight: false })
    }
  },

  async flistClearSavedCreds() {
    const credsApi = window.workbench?.creds
    if (!credsApi) return
    try {
      await credsApi.clear()
      const meta = await credsApi.getMeta()
      set({ flistSavedCreds: meta })
    } catch (err) {
      console.warn('[creds] clear failed:', err)
    }
  },

  async flistSetSavedAutoLogin(next) {
    const credsApi = window.workbench?.creds
    if (!credsApi) return
    try {
      await credsApi.setAutoLogin(next)
      const meta = await credsApi.getMeta()
      set({ flistSavedCreds: meta })
    } catch (err) {
      console.warn('[creds] set auto-login failed:', err)
    }
  },

  flistCloseSignIn() {
    set({ flistSignInOpen: false })
  },

  async flistSignIn(account, password, opts) {
    set({ flistSignInStatus: 'submitting', flistSignInError: null })
    try {
      const res = await api.flistSignIn({ account, password })
      get().flistRememberAccount(account)
      // Persist (or clear) saved credentials based on the modal's
      // checkbox state. Auto-login implies remember-password — the
      // modal enforces that, but we also enforce it here so a
      // programmatic call can't end up with autoLogin=true + no
      // saved password. Failures here don't block sign-in (the
      // user has already authenticated); a save failure surfaces
      // via flistSavedCreds.encryptionAvailable on the next reload.
      //
      // `opts === undefined` means "this is a programmatic re-login"
      // (auto-login path) — don't touch the keychain at all. Without
      // this guard, every auto-login on launch ran the else-branch
      // below and cleared the saved password, so the second close →
      // relaunch always landed on the sign-in modal.
      if (opts !== undefined) {
        const remember = !!opts.rememberPassword || !!opts.autoLogin
        const autoLogin = !!opts.autoLogin
        const credsApi = window.workbench?.creds
        if (credsApi) {
          try {
            if (remember) {
              await credsApi.save({ account, password, autoLogin })
            } else {
              await credsApi.clear()
            }
            // Refresh in-memory mirror so Settings reflects reality
            // without a page reload.
            const meta = await credsApi.getMeta()
            set({ flistSavedCreds: meta })
          } catch (err) {
            console.warn('[creds] save failed:', err)
          }
        }
      }
      // Bump the session epoch so any in-flight mapping-list fetch from
      // a prior account is discarded on arrival (QA P2-4). Also reset
      // flistMapping to idle so KinksPane re-fires loadMapping — a
      // prior 401 (e.g. KinksPane mounting before sign-in completed)
      // would otherwise leave the picker permanently empty.
      _flistSessionEpoch++
      _mappingInflight = null
      set((s) => {
        // Reset flistMapping on ANY status except 'ready'. A picker
        // that already has a usable payload stays put; everything
        // else — 'idle' (never tried), 'loading' (in-flight against
        // the pre-sign-in epoch, which loadMapping's epoch guard
        // will silently drop), 'error' (a 401 from a pre-sign-in
        // mount) — gets blown back to idle so KinksPane's
        // useEffect fires a fresh load against the newly-active
        // session. Previously only 'error' was reset; a 'loading'
        // status that pre-dated sign-in would stay stuck forever
        // because the epoch-bumped in-flight call returns silently.
        const mappingNeedsReset = s.flistMapping.status !== 'ready'
        // Wipe stale "not signed in" pullErrors left by auto-pull
        // attempts that fired before the session was active — sign-in
        // just made them obsolete. Other pullError causes (network,
        // ticket-expired) will re-surface on the next pull attempt.
        const archive: typeof s.flistArchive = {}
        for (const [id, slot] of Object.entries(s.flistArchive)) {
          archive[id] = slot.pullError ? { ...slot, pullError: null } : slot
        }
        return {
          flistSignInStatus: 'idle',
          flistSignInOpen: false,
          flistAccountCharacters: res.characters,
          flistSession: {
            active: true,
            account: res.account,
            expires_in_sec: res.expires_in_sec
          },
          // Archive-owned field: flistArchive.
          flistArchive: archive,
          ...(mappingNeedsReset ? { flistMapping: idleMapping() } : {})
        }
      })
      await get().flistLoadRoster()
      // Auto-refresh: walk the roster and queue a background pull
      // for every account character whose local copy is older than
      // the user's configured threshold (Settings → F-list). 0
      // minutes = always re-pull. The picker's per-row badges show
      // progress; a character already being pulled (a manual ↻
      // Refresh) is skipped as busy. Fire-and-forget.
      void _flistAutoRefreshOnLogin(get, set)
    } catch (err) {
      // The modal shows "Invalid account name or password", not
      // "HTTP 401: Invalid account name or password".
      set({ flistSignInStatus: 'error', flistSignInError: errorDetail(err) })
    }
  },

  async flistSignOut() {
    // Save pending Workbench edits before tearing down — the 500 ms
    // autosave debounce can otherwise drop the user's last edits
    // (QA P1-1). The flush also waits out a save already on its way.
    await get().flistFlushAllWorking()
    // Cancel running Pulls and Back up all BEFORE clearing the ticket so
    // the sidecar doesn't keep writing live.json + image bytes against a
    // torn-down session. They are jobs: closing their streams would not
    // stop them, a cancel by id does.
    const jobIds = [
      ...Object.values(get().flistArchive).map((slot) => slot.pullJobId),
      get().flistBackupAllStatus.jobId
    ].filter((id): id is string => Boolean(id))
    await Promise.all(jobIds.map((id) => api.jobCancel(id).catch(() => undefined)))
    const ctrl = get().flistPullAbortController
    if (ctrl) {
      try { ctrl.abort() } catch { /* already aborted */ }
    }
    try {
      await api.flistSignOut()
    } catch {
      // Server-side clear is best-effort; clearing local state is the
      // user-visible signal that matters.
    }
    // Bump session epoch so any in-flight network call (mapping list,
    // archive load, etc.) that returns after this point is discarded
    // rather than reinstating the signed-out account's data (QA P2-4).
    _flistSessionEpoch++
    _mappingInflight = null
    // Drop every Workbench so a different account logging in doesn't
    // see another user's cached data (Tier 2 §2.x).
    get().flistDropAllWorkbenches()
    set({
      flistSession: { active: false },
      flistAccountCharacters: [],
      // Purge the mapping cache too.
      flistMapping: idleMapping(),
      // Archive-owned field: flistPullAbortController.
      flistPullAbortController: null
    })
    await get().flistLoadRoster()
  },

  async flistRefreshSession() {
    try {
      const status = await api.flistSession()
      set({ flistSession: status })
      if (!status.active && get().flistActiveCharacterId !== null) {
        // Session lapsed (e.g. sidecar restart). Drop active selection
        // so the UI doesn't render stale read-only docs.
        // Workbench-owned fields: flistActiveCharacterId, editorReadOnly.
        set({ flistActiveCharacterId: null, editorReadOnly: false })
      }
    } catch {
      // Sidecar unreachable — leave existing flag, /health card already
      // surfaces it.
    }
  },

  async flistLoadRoster() {
    set({ flistRosterStatus: 'loading' })
    try {
      const { characters } = await api.flistRoster()
      set((s) => {
        // Archive-owned field: flistArchive (each entry's integrity).
        const archive = { ...s.flistArchive }
        for (const entry of characters) {
          if (entry.id === null || !entry.pull_status) continue
          const key = String(entry.id)
          const prev = archive[key] ?? {
            live: null,
            pullStatus: 'idle' as const,
          }
          archive[key] = {
            ...prev,
            integrity: {
              status: entry.pull_status.status,
              missing: entry.pull_status.missing_image_ids.length,
            },
          }
        }
        return {
          flistRoster: characters,
          flistRosterStatus: 'ready',
          flistArchive: archive,
        }
      })
      // Restore the previously-selected character so signing back in
      // lands the user on their default rather than the picker's
      // empty state. Only fires when nothing is currently selected
      // and the saved id still resolves against the fresh roster.
      // Route through selectCharacter(name) — going through the lower
      // flistSelectCharacter would only set flistActiveCharacterId and
      // leave activeCharacter (the picker chip's source) untouched,
      // so the chip and the working-sets zone end up on different
      // characters when loadCharacters() races in and defaults
      // activeCharacter to characters[0].
      if (get().flistActiveCharacterId === null) {
        const savedId = get().flistLastCharacterId()
        if (savedId) {
          const entry = characters.find((c) => String(c.id ?? '') === savedId)
          if (entry) {
            get().selectCharacter(entry.name)
          }
        }
      }
    } catch {
      set({ flistRosterStatus: 'error' })
    }
  },

  async flistRefreshAllAccount() {
    await _flistAccountSweep(get, set, null)
  },

  async flistLoadMapping(opts) {
    const status = get().flistMapping.status
    // Return the in-flight promise instead of resolving immediately
    // (QA P3-4) so callers can sequence reads of `flistMapping.payload`.
    if (status === 'loading' && !opts?.force && _mappingInflight) {
      return _mappingInflight
    }
    const epoch = _flistSessionEpoch
    set((s) => ({
      flistMapping: { ...s.flistMapping, status: 'loading', error: null }
    }))
    // Assigned once, after the closure that reads it is created.
    // eslint-disable-next-line prefer-const
    let resolvedPromise!: Promise<void>
    const work = (async () => {
      try {
        const payload = await api.flistMappingList({ force: opts?.force })
        if (epoch !== _flistSessionEpoch) return
        set({
          flistMapping: {
            status: 'ready',
            payload,
            etag: payload._etag ?? null,
            fetchedAt: payload._fetched_at ?? null,
            error: null
          }
        })
      } catch (err) {
        if (epoch !== _flistSessionEpoch) return
        const raw = err instanceof Error ? err.message : String(err)
        set((s) => ({
          flistMapping: { ...s.flistMapping, status: 'error', error: raw }
        }))
      } finally {
        if (_mappingInflight === resolvedPromise) {
          _mappingInflight = null
        }
      }
    })()
    resolvedPromise = work
    _mappingInflight = resolvedPromise
    return resolvedPromise
  }
})
