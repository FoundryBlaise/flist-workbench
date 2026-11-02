import type { FlistZipBackupEntry } from '../lib/api'
import { formatBackupOrigin } from '../lib/backupOrigin'

/** One entry of the Diff tab's picker: what the Workbench can be
 *  compared with. The Workbench is always the left side. Live comes
 *  first, as the default, since it is what an Upload would change. Then
 *  the character's Backups, newest first, each saying what it holds and
 *  why it was made. */
export type DiffSource =
  | { kind: 'live'; lastPullAt: number | null }
  | {
      kind: 'backup'
      filename: string
      createdAt: number
      /** The name the user gave the Backup, if any. */
      name: string | null
      /** e.g. "Workbench · before Restore", or "Source unknown". */
      origin: string
    }

type DiffSourcesState = {
  flistArchive: Record<
    string,
    { lastPullAt?: number | null; zipBackups?: FlistZipBackupEntry[] } | undefined
  >
}

/** The Diff picker's entries for `characterId`, from the archive the
 *  store loaded (Live and the Backup list). */
export function selectDiffSources(s: DiffSourcesState, characterId: string): DiffSource[] {
  const archive = s.flistArchive[characterId]
  const backups = archive?.zipBackups ?? []
  return [
    { kind: 'live', lastPullAt: archive?.lastPullAt ?? null },
    // A Backup that holds no profile (the one the move to one Workbench
    // made of older files) has nothing in it to compare.
    ...backups.filter((b) => b.holds_profile).map(
      (b): DiffSource => ({
        kind: 'backup',
        filename: b.filename,
        createdAt: b.created_at,
        name: b.name,
        origin: formatBackupOrigin(b)
      })
    )
  ]
}
