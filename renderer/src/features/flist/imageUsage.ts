import type { FlistImageReferences } from '../../lib/api'

/** What to tell the user before images go to the Trash: which of them
 *  are still used somewhere else. Trashing those is allowed — the files
 *  can come back — but nobody should find out afterwards. */
export function usageNotes(
  imageIds: string[],
  refs: Record<string, FlistImageReferences>
): string[] {
  let live = 0
  let workbench = 0
  let kept = 0
  let backups = 0
  for (const id of imageIds) {
    const r = refs[id]
    if (!r) continue
    if (r.live) live++
    if (r.workbench) workbench++
    if (r.backups > 0) {
      kept++
      backups = r.backups
    }
  }
  const one = imageIds.length === 1
  const howMany = (n: number) => (one ? 'It' : `${n} of these`)
  const is = (n: number) => (one || n === 1 ? 'is' : 'are')
  const notes: string[] = []
  if (live > 0) {
    notes.push(
      `${howMany(live)} ${is(live)} on the live profile — the next pull fetches ${
        live === 1 ? 'it' : 'them'
      } again.`
    )
  }
  if (workbench > 0) {
    notes.push(`${howMany(workbench)} ${is(workbench)} still in the Workbench’s gallery.`)
  }
  if (kept > 0) {
    notes.push(
      one && backups > 1
        ? `It is kept in ${backups} Backups, which hold their own copy.`
        : `${howMany(kept)} ${is(kept)} kept in a Backup, which holds its own copy.`
    )
  }
  return notes
}

export const FLIST_MAX_UPLOAD_BYTES = 2_000_000

export function formatBytes(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`
  if (n >= 1_000) return `${Math.round(n / 1_000)} KB`
  return `${n} B`
}
