// The Archive slice: what the app keeps of each character beside its
// Workbench. Live per character, Pulls and the jobs they run as, the
// Backup list with browsing, renaming, deleting and downloading a
// Backup, Back up all, the Pool and the Trash. The timers of the Back up
// all banner and the Pull's abort controller live here too.
//
// The Workbench slot is not the Archive's: where an Archive action
// changes what the Workbench shows (a Pull bringing a new Live, a
// browsed Backup in the slot, images taken off the gallery by the
// sidecar), it calls a Workbench action through `get()`. The Workbench
// in turn reads Live through `flistEnsureLive` and ends a browse with
// `flistEndBrowse`.

import {
  api,
  errorDetail,
  RefusalError,
  type FlistBackupAllHandlers,
  type FlistCharacterImage,
  type FlistPullHandlers,
  type FlistZipBackupEntry,
  type Job
} from '../../lib/api'
import type { State } from '../../state'
import type { SliceCreator } from './slice'

type ArchiveSet = Parameters<SliceCreator<ArchiveSlice>>[0]
type ArchiveGet = () => State

export type ArchiveState = {
  /** Per-character archive state. Keyed by character_id string. */
  flistArchive: Record<
    string,
    {
      live: Record<string, unknown> | null
      /** ZIP-backup files in `characters/<id>/backups/`, newest first.
       *  The Backups sidebar list reads from this slot. `undefined` means
       *  "not yet loaded for this character"; an empty array means
       *  "loaded, none exist". */
      zipBackups?: FlistZipBackupEntry[]
      zipBackupsStatus?: 'idle' | 'loading' | 'ready' | 'error'
      zipBackupsError?: string | null
      pullStatus: 'idle' | 'queued' | 'running' | 'done' | 'error'
      pullStage?: string
      pullProgress?: { done: number; total: number }
      pullError?: string | null
      /** The running Pull job, for Cancel. */
      pullJobId?: string | null
      lastPullAt?: number | null
      // On-disk integrity status: was the prior pull complete, or was
      // it interrupted / did some images fail? Sourced from
      // /flist/characters (server walks images_dir) and updated when a
      // new pull's "done" event arrives. Drives the "Pull incomplete"
      // affordance in FlistCharacterZone.
      integrity?: {
        status: 'complete' | 'partial' | 'interrupted' | 'unknown' | 'never_pulled'
        missing: number
      }
    }
  >
  /** Currently-open read-only backup browse target, or null when
   *  the user is editing their live working copy. When set, the
   *  editor pane renders the backup's contents via the
   *  `flistDiffBackupCache` (Tier 4's existing backup-loader) with
   *  every tab in readOnly mode. Right-click → Browse backup in the
   *  Backups sidebar list sets this; switching character or closing
   *  via the header pill clears it. See features/flist/BrowseBackup
   *  for the rendering path. */
  flistBrowseBackup: {
    characterId: string
    filename: string
    /** 'loading' → backup ZIP being fetched and parsed.
     *  'ready'   → payload available, tabs can render.
     *  'error'   → fetch failed, header pill shows reason. The most
     *              common error is 409 `backup_too_old` — backup
     *              predates the Browse-support write that bundles
     *              working.json into the ZIP. */
    status: 'loading' | 'ready' | 'error'
    /** The decoded working.json payload from the ZIP. Set when
     *  status === 'ready'; null otherwise. */
    payload: Record<string, unknown> | null
    error?: string | null
    /** Why this backup was created. Read from the ZIP's
     *  `backup-meta.json` (added 2026-06-17). Older backups without
     *  that file fall back to `'unknown'`. Surfaced in the header
     *  banner: "Viewing backup · <date> · Manual" and in the
     *  sidebar Backups list. */
    kind?: 'manual_single' | 'manual_bulk' | 'import' | 'scheduled' | 'unknown'
    /** Human-readable backup creation timestamp for the header banner
     *  (already-formatted, so the renderer doesn't keep reformatting
     *  on every keystroke during browse). */
    dateLabel?: string
    /** Stashed state restored on close. Browse mode hijacks
     *  `flistArchive[id].live` so the existing From-F-list rendering
     *  pipeline (ProfileFieldsPreview / KinksPane / ImagesTab /
     *  PreviewPane with inlines + F-list theme) renders the backup
     *  byte-for-byte identically to the live view — we revert the
     *  hijack here on close so the user's actual data isn't damaged. */
    previousLive: Record<string, unknown> | null
    /** Whether the Live row was shown, so close returns to it. */
    previousViewingLive: boolean
  } | null
  /** Per-character snapshot of files in `<char>/images/` (the v5
   *  unified store — there's no separate sha-keyed pool). Keyed by
   *  image_id with the file extension + mtime cached so the renderer
   *  can render thumbs and sort Pool view newest-first without a
   *  second round-trip. Anything in this map whose image_id isn't
   *  referenced by working.json's gallery is "in the pool" view. */
  flistCharacterImages: Record<
    string,
    {
      byId: Record<
        string,
        { extension: string; size: number; added_at?: number }
      >
      status: 'idle' | 'loading' | 'ready' | 'error'
    }
  >
  /** Tools → "Back up all characters" progress. `running` while the SSE
   *  stream is open; the banner reads currentName + (done/total) live,
   *  then summary `phase = 'done'` for 6s before auto-clearing. */
  flistBackupAllStatus: {
    phase: 'idle' | 'running' | 'done' | 'cancelled' | 'error'
    total: number
    done: number
    saved: number
    unchanged: number
    failed: number
    currentName: string | null
    errorMessage: string | null
    /** The running Back up all job, for Cancel. Null for a single
     *  character's Backup, which is no job. */
    jobId?: string | null
  }
  /** AbortController for the in-flight character pull. Sign-out
   *  aborts this before clearing the ticket so a long-running pull
   *  doesn't continue writing to disk against a torn-down session. */
  flistPullAbortController: AbortController | null
}

export type ArchiveSlice = ArchiveState & {
  flistLoadArchive: (characterId: string) => Promise<void>
  /** The character's Live: the one the window holds, else read from the
   *  sidecar and kept; null when the character has none. For the
   *  Workbench, which seeds a character's first Workbench from it. */
  flistEnsureLive: (characterId: string) => Promise<Record<string, unknown> | null>
  /** Pull a character from F-list into its slot. `skipWhenBusy`: when
   *  a job already holds the character, leave the slot without an
   *  error (Refresh all) instead of saying so. */
  flistPullCharacter: (
    name: string,
    characterId?: string | null,
    opts?: { skipWhenBusy?: boolean }
  ) => Promise<void>
  /** Cancel the character's running Pull (a job): it stops at its next
   *  step, keeping what it already wrote. */
  flistCancelPull: (characterId: string) => Promise<void>
  /** Follow the Pulls and Back up all the sidecar is still running, as
   *  after the window reloaded: their progress shows again and they
   *  can be cancelled. */
  flistResumeJobs: () => Promise<void>
  flistLoadCharacterImages: (characterId: string) => Promise<void>
  /** Upload a local image. Lands in `images/` as a `local-<sha8>` and
   *  shows up in the Pool view; the caller is responsible for moving
   *  it on-profile via flistMoveImageToProfile if that's the intent. */
  flistUploadImage: (
    characterId: string,
    file: File | Blob
  ) => Promise<FlistCharacterImage>
  /** Delete images, on the profile or only in the pool, in one request:
   *  the sidecar takes gallery images off the Workbench's gallery and
   *  moves every file to the Trash, the same route a model's
   *  `trash_images` takes. Only the ids the sidecar actually moved leave
   *  the pool listing; a failed request throws instead of pretending. */
  flistTrashImages: (
    characterId: string,
    imageIds: string[]
  ) => Promise<string[]>
  /** Re-read the character's Backup list, after a Backup this window
   *  did not make. A failure leaves the list as it was. */
  flistLoadBackups: (characterId: string) => Promise<void>
  /** Tools → "Back up all characters". Walks the signed-in account
   *  roster, pulls each character (JSON + images + avatar), and
   *  writes a userscript-restoreable ZIP per character. Single-flight:
   *  a second call while one is running is a no-op. */
  flistBackupAll: () => Promise<void>
  /** Cancel the running Back up all: it stops at its next step; the
   *  Backups it already wrote stay. */
  flistCancelBackupAll: () => Promise<void>
  /** Right-click → "Back up now" on a single character row. Pulls
   *  the character (full, with images), then forces a ZIP backup write
   *  to `characters/<id>/backups/<ISO>.zip`. Uses the same Backup-all
   *  banner UI so the user sees progress, with `total: 1`. */
  /** Pack a character into a restoreable ZIP.
   *
   *  `pull` decides what is being archived. From the read-only
   *  "Live on F-List" row it is true: refresh from the website
   *  first, so the ZIP holds every image byte the userscript would
   *  need. From the Workbench row it must be false — the bench
   *  holds edits that exist nowhere else, and pulling to save them
   *  would move Live underneath them (and fail offline, for a
   *  backup that needs no network at all). */
  flistBackupCharacter: (
    name: string,
    opts?: { pull?: boolean }
  ) => Promise<void>
  /** Right-click → Browse backup on a row in the Backups sidebar
   *  list. Loads the ZIP into the existing diff backup cache,
   *  flips `flistBrowseBackup` so the editor renders read-only
   *  against that backup's payload. No-op when the same target is
   *  already open. Safe to call without a dirty-working guard —
   *  browse mode never mutates working.json. */
  flistOpenBrowseBackup: (
    characterId: string,
    backupFilename: string
  ) => Promise<void>
  /** Header-pill "Back to working copy" / character switch / Escape.
   *  Clears `flistBrowseBackup` so the editor tabs render against
   *  the live working copy again. */
  flistCloseBrowseBackup: () => void
  /** End the browsed Backup where it is: Live goes back to what the
   *  browse stood in for, and nothing else changes; what the window
   *  shows next is the caller's to decide. For the Workbench, when a
   *  Restore or reset to Live replaces the browsed view. */
  flistEndBrowse: () => void
  /** Right-click → Download ZIP… on a Backups row. OS save dialog
   *  defaults the filename to the backup's on-disk name; we don't
   *  invent a friendlier one because the timestamp+UTC marker is
   *  exactly what a user copying the file off-machine wants. */
  flistDownloadZipBackup: (
    characterId: string,
    backupFilename: string
  ) => Promise<{ path: string; bytes: number } | null>
  /** Right-click → Delete backup on a Backups row. The sidecar moves
   *  the ZIP to the character's Trash, where the Trash view can
   *  restore it. Refreshes the sidebar list on success. If the deleted
   *  backup is currently being browsed, also closes browse mode so the
   *  editor doesn't display a Backup that has left the list. */
  flistDeleteZipBackup: (
    characterId: string,
    backupFilename: string
  ) => Promise<boolean>
  /** Right-click → Rename… on a Backups row. The ZIP file itself
   *  isn't modified; the rename is a sidecar-stored label persisted
   *  in `_names.json`. Empty string clears the rename. Patches the
   *  in-memory row + the open Browse-backup banner if applicable. */
  flistRenameZipBackup: (
    characterId: string,
    backupFilename: string,
    name: string
  ) => Promise<boolean>
}

/** The Archive state as the window starts: nothing read yet, no Pull
 *  or Back up all followed. Tests reset the slice with
 *  `useStore.setState(archiveInitialState())`. */
export function archiveInitialState(): ArchiveState {
  return {
    flistArchive: {},
    flistCharacterImages: {},
    flistBrowseBackup: null,
    flistBackupAllStatus: {
      phase: 'idle',
      total: 0,
      done: 0,
      saved: 0,
      unchanged: 0,
      failed: 0,
      currentName: null,
      errorMessage: null
    },
    flistPullAbortController: null
  }
}

/** Re-read a character's Backup list so a Backup the sidecar just
 *  wrote shows up. A failure leaves the list stale. */
function _refreshBackupList(characterId: string, set: ArchiveSet): Promise<void> {
  return api
    .flistZipBackups(characterId)
    .then((r) => {
      set((s) => {
        const entry = s.flistArchive[characterId]
        if (!entry) return {}
        return {
          flistArchive: {
            ...s.flistArchive,
            [characterId]: {
              ...entry,
              zipBackups: r.backups,
              zipBackupsStatus: 'ready',
              zipBackupsError: null
            }
          }
        }
      })
    })
    .catch(() => {})
}

const IDLE_BACKUP_ALL_STATUS: State['flistBackupAllStatus'] = {
  phase: 'idle',
  total: 0,
  done: 0,
  saved: 0,
  unchanged: 0,
  failed: 0,
  currentName: null,
  errorMessage: null,
  jobId: null
}

/** The job holding a character that a Pull or Back up all was refused
 *  for (`character_busy`), or null when `err` is another failure. */
function _characterBusyWith(err: unknown): 'pull' | 'backup-all' | null {
  if (!(err instanceof RefusalError) || err.code !== 'character_busy') return null
  return err.details.kind === 'backup-all' ? 'backup-all' : 'pull'
}

/** Follow a Pull job into the character's slot: its progress, its job
 *  id (for Cancel), and on `done` the reloads a finished Pull needs.
 *  `open` starts the Pull or follows one already running; aborting the
 *  signal (sign-out) only stops following, the job runs on. A Pull
 *  refused because a job holds the character says so in plain words,
 *  or with `skipWhenBusy` leaves the slot idle, its stage `busy`. */
async function _followPull(
  get: ArchiveGet,
  set: ArchiveSet,
  targetId: string | null,
  open: (handlers: FlistPullHandlers, signal: AbortSignal) => Promise<void>,
  opts: { skipWhenBusy?: boolean } = {}
): Promise<void> {
  const setStatus = (
    patch: Partial<{
      pullStatus: 'idle' | 'queued' | 'running' | 'done' | 'error'
      pullStage: string
      pullProgress: { done: number; total: number }
      pullError: string | null
      pullJobId: string | null
    }>
  ) => {
    if (!targetId) return
    set((s) => ({
      flistArchive: {
        ...s.flistArchive,
        [targetId]: {
          ...(s.flistArchive[targetId] ?? {
            live: null,
            pullStatus: 'idle'
          }),
          ...patch
        }
      }
    }))
  }
  setStatus({ pullStatus: 'queued', pullError: null })
  const ctrl = new AbortController()
  set({ flistPullAbortController: ctrl })
  try {
    await open({
      job: (job) => setStatus({ pullJobId: job.id }),
      cancelled: () =>
        setStatus({ pullStatus: 'idle', pullStage: 'cancelled', pullError: null, pullJobId: null }),
      ticket: () =>
        setStatus({ pullStatus: 'running', pullStage: 'ticket' }),
      fetching: () =>
        setStatus({ pullStatus: 'running', pullStage: 'fetching' }),
      images: ({ total }) =>
        setStatus({
          pullStatus: 'running',
          pullStage: 'images',
          pullProgress: { done: 0, total }
        }),
      image: ({ index, total, ok, cached }) => {
        setStatus({ pullProgress: { done: index, total } })
        // Refresh the per-character images map so the Images tab's
        // thumbnails update as files arrive. Only every 10th image to
        // avoid hammering the sidecar with one HTTP GET per download
        // (the rate-limited CDN already paces us at ~2/s, so a 10x
        // skip means the Images tab refreshes every ~5 seconds during
        // a long pull). Cached events don't change disk state.
        if (targetId && ok && !cached && (index % 10 === 0 || index === total)) {
          void get().flistLoadCharacterImages(targetId)
        }
      },
      done: async (info) => {
        // We know the character_id now even if we didn't before. Make
        // sure the per-id slot exists and gets reloaded.
        set((s) => ({
          flistArchive: {
            ...s.flistArchive,
            [info.character_id]: {
              ...(s.flistArchive[info.character_id] ?? {
                live: null,
                pullStatus: 'idle'
              }),
              pullStatus: 'done',
              pullStage: 'done',
              pullJobId: null
            }
          }
        }))
        await get().flistLoadArchive(info.character_id)
        await get().flistLoadCharacterImages(info.character_id)
        await get().flistLoadRoster()
        // The Workbench open on this character follows the new Live.
        get().flistNoteNewLive(info.character_id)
      },
      error: ({ message }) => {
        setStatus({ pullStatus: 'error', pullError: message, pullJobId: null })
      }
    }, ctrl.signal)
  } catch (err) {
    // AbortError = user-initiated (sign-out / explicit cancel).
    // Don't surface as a scary error to the user.
    const raw = errorDetail(err)
    const busyWith = _characterBusyWith(err)
    if (err instanceof Error && err.name === 'AbortError') {
      setStatus({ pullStatus: 'idle', pullError: null })
    } else if (busyWith && opts.skipWhenBusy) {
      setStatus({ pullStatus: 'idle', pullStage: 'busy', pullError: null })
    } else if (busyWith) {
      setStatus({
        pullStatus: 'error',
        pullError:
          busyWith === 'backup-all'
            ? 'Back up all is running; it pulls this character too.'
            : 'This character is already being pulled.'
      })
    } else {
      setStatus({ pullStatus: 'error', pullError: raw })
    }
  } finally {
    if (get().flistPullAbortController === ctrl) {
      set({ flistPullAbortController: null })
    }
  }
}

/** Follow a Back up all job into the banner's status. `open` starts it
 *  or follows one already running. */
async function _followBackupAll(
  get: ArchiveGet,
  set: ArchiveSet,
  open: (handlers: FlistBackupAllHandlers) => Promise<void>
): Promise<void> {
  try {
    await open({
      job: (job) => {
        set((s) => ({ flistBackupAllStatus: { ...s.flistBackupAllStatus, jobId: job.id } }))
      },
      cancelled: () => {
        set((s) => ({
          flistBackupAllStatus: {
            ...s.flistBackupAllStatus,
            phase: 'cancelled',
            currentName: null,
            jobId: null
          }
        }))
        _clearBackupAllStatusLater(get, set, 'cancelled')
      },
      start: ({ total }) => {
        set((s) => ({
          flistBackupAllStatus: { ...s.flistBackupAllStatus, total }
        }))
      },
      character: (info) => {
        set((s) => {
          const cur = s.flistBackupAllStatus
          if (info.status === 'fetching') {
            return {
              flistBackupAllStatus: { ...cur, currentName: info.name }
            }
          }
          // Per-character terminal status: bump counters + done.
          const next = {
            ...cur,
            done: cur.done + 1,
            saved: cur.saved + (info.status === 'saved' ? 1 : 0),
            unchanged:
              cur.unchanged + (info.status === 'unchanged' ? 1 : 0),
            failed: cur.failed + (info.status === 'error' ? 1 : 0)
          }
          return { flistBackupAllStatus: next }
        })
        // Refresh the archive slot from disk after each successful
        // per-character pull. Both 'saved' (ZIP written, content
        // changed) and 'unchanged' (ZIP dedup'd, content matched
        // last backup) imply the per-character pull preceded the
        // ZIP step and put fresh live.json + images on disk. Without
        // this, the picker would keep showing 'pulled 16h ago' for
        // every character even though Back up all just
        // updated all of them — wasted disk + network on subsequent
        // manual REFRESH ALL clicks. flistLoadArchive reads from
        // local /flist/character/{id}/live (no F-list network),
        // updates the live payload + zipBackups +
        // lastPullAt in one pass.
        const refreshable =
          (info.status === 'saved' || info.status === 'unchanged') &&
          info.character_id
        if (refreshable) {
          void get().flistLoadArchive(info.character_id!)
        }
      },
      done: () => {
        set((s) => ({
          flistBackupAllStatus: {
            ...s.flistBackupAllStatus,
            phase: 'done',
            currentName: null
          }
        }))
        // Auto-clear the summary banner after 6s so it doesn't
        // linger past usefulness.
        setTimeout(() => {
          const cur = get().flistBackupAllStatus
          if (cur.phase === 'done') {
            set({
              flistBackupAllStatus: {
                phase: 'idle',
                total: 0,
                done: 0,
                saved: 0,
                unchanged: 0,
                failed: 0,
                currentName: null,
                errorMessage: null
              }
            })
          }
        }, 6000)
      },
      error: ({ message }) => {
        set((s) => ({
          flistBackupAllStatus: {
            ...s.flistBackupAllStatus,
            phase: 'error',
            errorMessage: message,
            currentName: null
          }
        }))
      }
    })
  } catch (err) {
    const busyWith = _characterBusyWith(err)
    const message =
      busyWith === 'pull'
        ? 'A Pull is running. Start Back up all again once it has finished.'
        : busyWith === 'backup-all'
          ? 'Back up all is already running.'
          : errorDetail(err)
    set((s) => ({
      flistBackupAllStatus: {
        ...s.flistBackupAllStatus,
        phase: 'error',
        errorMessage: message,
        currentName: null
      }
    }))
  }
}

function _startBackupAllStatus(set: ArchiveSet, jobId: string | null): void {
  set({
    flistBackupAllStatus: {
      phase: 'running',
      total: 0,
      done: 0,
      saved: 0,
      unchanged: 0,
      failed: 0,
      currentName: null,
      errorMessage: null,
      jobId
    }
  })
}

/** Back to idle after 6 s, unless something else started meanwhile. */
function _clearBackupAllStatusLater(
  get: ArchiveGet,
  set: ArchiveSet,
  phase: 'done' | 'cancelled'
): void {
  setTimeout(() => {
    if (get().flistBackupAllStatus.phase !== phase) return
    set({ flistBackupAllStatus: { ...IDLE_BACKUP_ALL_STATUS } })
  }, 6000)
}

/** The character a running Pull job writes: the one its resource names
 *  (`character:<id>`), else the roster entry with its name, else the id
 *  it reported once F-list answered. */
function _pullTarget(state: State, job: Job): string | null {
  const held = /^character:(\d+)$/.exec(job.resource)
  if (held) return held[1]
  const name = typeof job.params.name === 'string' ? job.params.name.toLowerCase() : null
  const entry = name ? state.flistRoster.find((r) => r.name.toLowerCase() === name) : undefined
  if (entry?.id != null) return String(entry.id)
  const reported = job.progress.character_id
  return typeof reported === 'string' ? reported : null
}

/** Normalise the `kind` field from a backup's `backup-meta.json`.
 *  Backups predating the meta write (or hand-crafted via the file
 *  system) get `'unknown'` so the UI can show "Backup · unknown
 *  reason" rather than a missing badge. */
function normaliseBackupKind(
  raw: unknown
): 'manual_single' | 'manual_bulk' | 'import' | 'scheduled' | 'unknown' {
  if (
    raw === 'manual_single' ||
    raw === 'manual_bulk' ||
    raw === 'import' ||
    raw === 'scheduled'
  ) {
    return raw
  }
  return 'unknown'
}

/** Format a backup's filename (`YYYY-MM-DDTHHMMSSZ.zip`) into the
 *  local-time label shown in the Browse-backup header banner.
 *  Returns the raw filename as a fallback so a malformed name doesn't
 *  hide the affordance entirely. */
function formatBackupDateForBanner(filename: string): string {
  const m = filename.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})Z/
  )
  if (!m) return filename
  const [, y, mo, d, h, mi] = m
  const date = new Date(
    Date.UTC(
      Number(y),
      Number(mo) - 1,
      Number(d),
      Number(h),
      Number(mi),
      0
    )
  )
  if (isNaN(date.getTime())) return filename
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n))
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Restore the editor state stashed when the user entered Browse mode:
 *  back to Live if that was shown, otherwise back to the Workbench.
 *
 *  Always restores `flistArchive[id].live` to its true value FIRST so
 *  whichever activation we call next reads the right source. Pulled
 *  out so flistCloseBrowseBackup AND flistOpenBrowseBackup (when
 *  switching from one backup to another) can both use it.
 */
function _restoreFromBrowse(
  getter: ArchiveGet,
  browse: NonNullable<State['flistBrowseBackup']>
): void {
  const { characterId, previousViewingLive } = browse
  getter().flistEndBrowse()
  // Back to the row the user was on. Both overwrite editorReadOnly and
  // the working slot (which the editor shows), so there is nothing to
  // undo here.
  if (previousViewingLive) {
    void getter().flistShowLive(characterId)
  } else {
    void getter().flistBackToWorkbench(characterId)
  }
}

export const createArchiveSlice: SliceCreator<ArchiveSlice> = (set, get) => ({
  ...archiveInitialState(),

  async flistLoadArchive(characterId) {
    // Initialise the slot if missing so the UI has somewhere to render
    // the "no Live yet" empty state.
    set((s) => ({
      flistArchive: {
        ...s.flistArchive,
        [characterId]: s.flistArchive[characterId] ?? {
          live: null,
          pullStatus: 'idle'
        }
      }
    }))
    // Flip zip-backups to loading so the sidebar shows a spinner
    // instead of an empty list while we fetch.
    set((s) => ({
      flistArchive: {
        ...s.flistArchive,
        [characterId]: {
          ...(s.flistArchive[characterId] ?? {
            live: null,
            pullStatus: 'idle'
          }),
          zipBackupsStatus: 'loading',
          zipBackupsError: null
        }
      }
    }))
    const [live, zipBackupsResult] = await Promise.all([
      api.flistLive(characterId).catch(() => null),
      api
        .flistZipBackups(characterId)
        .then((r) => ({ ok: true as const, backups: r.backups }))
        .catch((err: unknown) =>
          // A character never pulled is not in the archive yet (404
          // `character_not_found`): it simply has no backups.
          err instanceof RefusalError && err.code === 'character_not_found'
            ? { ok: true as const, backups: [] }
            : {
                ok: false as const,
                error: errorDetail(err)
              }
        )
    ])
    set((s) => ({
      flistArchive: {
        ...s.flistArchive,
        [characterId]: {
          ...(s.flistArchive[characterId] ?? { pullStatus: 'idle' }),
          live,
          zipBackups: zipBackupsResult.ok ? zipBackupsResult.backups : [],
          zipBackupsStatus: zipBackupsResult.ok ? 'ready' : 'error',
          zipBackupsError: zipBackupsResult.ok ? null : zipBackupsResult.error,
          lastPullAt:
            (live && typeof live.fetched_at === 'number'
              ? (live.fetched_at as number)
              : null) ?? null
        }
      }
    }))
  },

  async flistEnsureLive(characterId) {
    const held = get().flistArchive[characterId]?.live ?? null
    if (held) return held
    const fetched = await api.flistLive(characterId).catch(() => null)
    if (!fetched) return null
    set((s) => ({
      flistArchive: {
        ...s.flistArchive,
        [characterId]: {
          ...(s.flistArchive[characterId] ?? {
            live: null,
            pullStatus: 'idle'
          }),
          live: fetched
        }
      }
    }))
    return fetched
  },

  async flistPullCharacter(name, characterId, opts) {
    await _followPull(
      get,
      set,
      characterId ?? null,
      (handlers, signal) => api.flistPull(name, handlers, { signal }),
      opts
    )
  },

  async flistCancelPull(characterId) {
    const jobId = get().flistArchive[characterId]?.pullJobId
    if (!jobId) return
    // The Pull stops at its next await and its stream ends with
    // `cancelled`, which sets the slot back to idle.
    await api.jobCancel(jobId)
  },

  async flistResumeJobs() {
    let jobs: Job[]
    try {
      jobs = (await api.jobsList()).jobs
    } catch {
      return
    }
    for (const job of jobs) {
      if (job.state !== 'pending' && job.state !== 'running') continue
      if (job.kind === 'backup-all') {
        if (get().flistBackupAllStatus.jobId === job.id) continue
        _startBackupAllStatus(set, job.id)
        void _followBackupAll(get, set, (handlers) =>
          api.flistBackupAllFollow(job.id, handlers)
        )
      } else if (job.kind === 'pull') {
        const cid = _pullTarget(get(), job)
        if (cid && get().flistArchive[cid]?.pullJobId === job.id) continue
        void _followPull(get, set, cid, (handlers, signal) =>
          api.flistPullFollow(job.id, handlers, { signal })
        )
      }
    }
  },

  async flistLoadCharacterImages(characterId) {
    set((s) => ({
      flistCharacterImages: {
        ...s.flistCharacterImages,
        [characterId]: {
          byId: s.flistCharacterImages[characterId]?.byId ?? {},
          status: 'loading'
        }
      }
    }))
    try {
      const res = await api.flistCharacterImages(characterId)
      const byId: Record<
        string,
        { extension: string; size: number; added_at?: number }
      > = {}
      for (const img of res.images) {
        byId[img.image_id] = {
          extension: img.extension,
          size: img.size,
          added_at: img.added_at
        }
      }
      set((s) => ({
        flistCharacterImages: {
          ...s.flistCharacterImages,
          [characterId]: { byId, status: 'ready' }
        }
      }))
    } catch {
      set((s) => ({
        flistCharacterImages: {
          ...s.flistCharacterImages,
          [characterId]: {
            byId: s.flistCharacterImages[characterId]?.byId ?? {},
            status: 'error'
          }
        }
      }))
    }
  },

  async flistUploadImage(characterId, file) {
    const entry = await api.flistImageUpload(characterId, file)
    set((s) => {
      const prev = s.flistCharacterImages[characterId]
      const nextById = { ...(prev?.byId ?? {}) }
      nextById[entry.image_id] = {
        extension: entry.extension,
        size: entry.size,
        added_at: entry.added_at
      }
      return {
        flistCharacterImages: {
          ...s.flistCharacterImages,
          [characterId]: { byId: nextById, status: prev?.status ?? 'ready' }
        }
      }
    })
    return entry
  },

  async flistTrashImages(characterId, imageIds) {
    if (imageIds.length === 0) return []
    // The sidecar takes gallery images off the Workbench's gallery,
    // which writes the Workbench: what was typed is saved first.
    await get().flistSaveBeforeGalleryWrite(characterId, imageIds)
    const res = await api.flistImagesTrash(characterId, imageIds)
    const moved = res.trashed.map((t) => t.image_id)
    get().flistTakeOffGallery(characterId, res.off_gallery ?? [], res.etag)
    set((s) => {
      const prev = s.flistCharacterImages[characterId]
      if (!prev) return {}
      const nextById = { ...prev.byId }
      for (const id of moved) delete nextById[id]
      return {
        flistCharacterImages: {
          ...s.flistCharacterImages,
          [characterId]: { byId: nextById, status: prev.status }
        }
      }
    })
    return moved
  },

  flistLoadBackups(characterId) {
    return _refreshBackupList(characterId, set)
  },

  async flistBackupAll() {
    if (get().flistBackupAllStatus.phase === 'running') return
    _startBackupAllStatus(set, null)
    await _followBackupAll(get, set, (handlers) => api.flistBackupAll(handlers))
  },

  async flistCancelBackupAll() {
    const jobId = get().flistBackupAllStatus.jobId
    if (!jobId) return
    await api.jobCancel(jobId)
  },

  async flistBackupCharacter(name, opts) {
    if (get().flistBackupAllStatus.phase === 'running') return
    set({
      flistBackupAllStatus: {
        phase: 'running',
        total: 1,
        done: 0,
        saved: 0,
        unchanged: 0,
        failed: 0,
        currentName: name,
        errorMessage: null
      }
    })

    const finalise = (
      patch: Partial<State['flistBackupAllStatus']>,
      autoClear: boolean
    ) => {
      set((s) => ({
        flistBackupAllStatus: {
          ...s.flistBackupAllStatus,
          ...patch,
          currentName: null
        }
      }))
      if (autoClear) {
        setTimeout(() => {
          const cur = get().flistBackupAllStatus
          if (cur.phase === 'done') {
            set({
              flistBackupAllStatus: {
                phase: 'idle',
                total: 0,
                done: 0,
                saved: 0,
                unchanged: 0,
                failed: 0,
                currentName: null,
                errorMessage: null
              }
            })
          }
        }, 6000)
      }
    }

    const pullFirst = opts?.pull !== false
    if (pullFirst) {
      try {
        // Full pull (JSON + images + avatar) so the ZIP that follows
        // can include every byte the userscript would need to restore
        // the profile. Reuses the existing per-character pull endpoint
        // — that flow already handles ticket refresh, dedup of cached
        // images, and snapshot side-effect.
        await get().flistPullCharacter(name)
      } catch (err) {
        finalise(
          {
            phase: 'error',
            done: 1,
            failed: 1,
            errorMessage:
              errorDetail(err)
          },
          false
        )
        return
      }
    }

    // Resolve the character id — `flistRoster` is keyed by name, and
    // `flistArchive` by id; a pull writes the id into the roster
    // (live.fetched_at), and without one the roster already holds it.
    const roster = get().flistRoster
    const match = roster.find(
      (r) => r.name.toLowerCase() === name.toLowerCase()
    )
    const cid = match?.id ? String(match.id) : null
    if (!cid) {
      finalise(
        {
          phase: 'error',
          done: 1,
          failed: 1,
          errorMessage: `Could not resolve ID for ${name}`
        },
        false
      )
      return
    }

    try {
      const res = await api.flistZipBackup(cid)
      if (res.saved) {
        finalise({ phase: 'done', done: 1, saved: 1 }, true)
      } else {
        // The endpoint defaults to `force=true`, so dedup shouldn't
        // fire from here — but be defensive.
        finalise({ phase: 'done', done: 1, unchanged: 1 }, true)
      }
      // Refresh the sidebar Backups list so the new ZIP appears
      // immediately instead of waiting for the next character switch.
      // Fire-and-forget; failure is harmless (list stays stale).
      void api
        .flistZipBackups(cid)
        .then((r) => {
          set((s) => ({
            flistArchive: {
              ...s.flistArchive,
              [cid]: {
                ...(s.flistArchive[cid] ?? {
                  live: null,
                  pullStatus: 'idle'
                }),
                zipBackups: r.backups,
                zipBackupsStatus: 'ready',
                zipBackupsError: null
              }
            }
          }))
        })
        .catch(() => {})
    } catch (err) {
      finalise(
        {
          phase: 'error',
          done: 1,
          failed: 1,
          errorMessage:
            errorDetail(err)
        },
        false
      )
    }
  },

  async flistOpenBrowseBackup(characterId, backupFilename) {
    const current = get().flistBrowseBackup
    if (
      current &&
      current.characterId === characterId &&
      current.filename === backupFilename &&
      current.status === 'ready'
    ) {
      return
    }
    // If a previous browse session is open, restore its state first so
    // the snapshot we stash below is "the user's real editor", not
    // "the previous backup we hijacked".
    if (current) {
      _restoreFromBrowse(get, current)
    }

    // Snapshot the user's current editor state so close-browse can put
    // it back exactly. Hijacking flistArchive[id].live is what lets us
    // route every existing Live-view tab + the preview pane through the
    // identical render path with zero per-tab refactors.
    const previousLive = get().flistArchive[characterId]?.live ?? null
    const previousViewingLive = get().flistViewingLive[characterId] === true

    set({
      flistBrowseBackup: {
        characterId,
        filename: backupFilename,
        status: 'loading',
        payload: null,
        error: null,
        previousLive,
        previousViewingLive
      }
    })

    let payload: Record<string, unknown>
    let kind: 'manual_single' | 'manual_bulk' | 'import' | 'scheduled' | 'unknown'
    let dateLabel: string
    try {
      const res = await api.flistZipBackupPayload(characterId, backupFilename)
      // The user may have switched away while we were loading. Don't
      // overwrite a different target.
      const inflight = get().flistBrowseBackup
      if (
        !inflight ||
        inflight.characterId !== characterId ||
        inflight.filename !== backupFilename
      ) {
        return
      }
      payload = res.payload
      kind = normaliseBackupKind(res.meta?.kind)
      dateLabel = formatBackupDateForBanner(backupFilename)
    } catch (err) {
      const inflight = get().flistBrowseBackup
      if (
        !inflight ||
        inflight.characterId !== characterId ||
        inflight.filename !== backupFilename
      ) {
        return
      }
      set({
        flistBrowseBackup: {
          characterId,
          filename: backupFilename,
          status: 'error',
          payload: null,
          error: errorDetail(err),
          previousLive,
          previousViewingLive
        }
      })
      return
    }

    // The Backup goes into the Workbench slot first, as a read-only
    // view (the Workbench slice keeps the Workbench it covers aside for
    // undo). Then the "fake live" entry in the archive gets the payload
    // verbatim so downstream readers (ProfileFieldsPreview, KinksPane,
    // PreviewPane inlines resolution) see the same shape they always do.
    get().flistShowReadOnlyView(characterId, payload)
    set((s) => ({
      flistArchive: {
        ...s.flistArchive,
        [characterId]: {
          ...(s.flistArchive[characterId] ?? {
            pullStatus: 'idle'
          }),
          live: payload
        }
      },
      flistBrowseBackup: {
        characterId,
        filename: backupFilename,
        status: 'ready',
        payload,
        error: null,
        kind,
        dateLabel,
        previousLive,
        previousViewingLive
      }
    }))
  },

  flistCloseBrowseBackup() {
    const browse = get().flistBrowseBackup
    if (!browse) return
    _restoreFromBrowse(get, browse)
  },

  flistEndBrowse() {
    const browse = get().flistBrowseBackup
    if (!browse) return
    const { characterId, previousLive } = browse
    set((s) => ({
      flistArchive: {
        ...s.flistArchive,
        [characterId]: {
          ...(s.flistArchive[characterId] ?? {
            pullStatus: 'idle'
          }),
          live: previousLive
        }
      },
      flistBrowseBackup: null
    }))
  },

  async flistDownloadZipBackup(characterId, backupFilename) {
    const dialog = window.workbench?.saveFileDialog
    const write = window.workbench?.writeFile
    if (!dialog || !write) return null
    let bytes: Uint8Array
    try {
      bytes = await api.flistZipBackupDownload(characterId, backupFilename)
    } catch (err) {
      console.error('[flist] backup download fetch failed:', err)
      return null
    }
    const path = await dialog({
      title: 'Download backup ZIP',
      defaultPath: backupFilename,
      filters: [
        { name: 'F-list backup', extensions: ['zip'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    if (!path) return null
    const ok = await write(path, bytes)
    if (!ok) return null
    return { path, bytes: bytes.length }
  },

  async flistRenameZipBackup(characterId, backupFilename, name) {
    let updated: FlistZipBackupEntry
    try {
      updated = await api.flistZipBackupRename(
        characterId,
        backupFilename,
        name
      )
    } catch (err) {
      console.error('[flist] backup rename failed:', err)
      return false
    }
    set((s) => {
      const slot = s.flistArchive[characterId]
      const list = slot?.zipBackups
      if (!list) return {}
      const nextList = list.map((b) =>
        b.filename === backupFilename ? updated : b
      )
      const patch: Partial<State> = {
        flistArchive: {
          ...s.flistArchive,
          [characterId]: { ...slot, zipBackups: nextList }
        }
      }
      // If the renamed backup is being browsed right now, refresh
      // the header banner copy in the same set call so the UI
      // doesn't flash through a stale label.
      if (
        s.flistBrowseBackup &&
        s.flistBrowseBackup.characterId === characterId &&
        s.flistBrowseBackup.filename === backupFilename
      ) {
        patch.flistBrowseBackup = {
          ...s.flistBrowseBackup,
          // dateLabel stays the same — only the user-facing name
          // changed. We don't store the name in flistBrowseBackup
          // (the banner pulls it lazily from the archive list via a
          // selector) so no further update is needed here.
        }
      }
      return patch
    })
    return true
  },

  async flistDeleteZipBackup(characterId, backupFilename) {
    try {
      await api.flistZipBackupDelete(characterId, backupFilename)
    } catch (err) {
      console.error('[flist] backup delete failed:', err)
      return false
    }
    // If we were browsing the now-deleted backup, exit browse mode
    // before the list refresh so the editor doesn't keep rendering
    // bytes that no longer exist on disk.
    const browse = get().flistBrowseBackup
    if (
      browse &&
      browse.characterId === characterId &&
      browse.filename === backupFilename
    ) {
      get().flistCloseBrowseBackup()
    }
    // Optimistic local update: drop the row immediately so the
    // sidebar feels snappy. Then reload archive to reconcile (handles
    // the rare race where another window restored the file).
    set((s) => {
      const slot = s.flistArchive[characterId]
      if (!slot?.zipBackups) return {}
      return {
        flistArchive: {
          ...s.flistArchive,
          [characterId]: {
            ...slot,
            zipBackups: slot.zipBackups.filter(
              (b) => b.filename !== backupFilename
            )
          }
        }
      }
    })
    void get().flistLoadArchive(characterId)
    return true
  },
})
