import type { FlistImageReferences } from '../../lib/api'

/** What to tell the user before images go to the trash: which of them
 *  are still used somewhere else. Trashing those is allowed — the files
 *  can come back — but nobody should find out afterwards. */
export function usageNotes(
  imageIds: string[],
  refs: Record<string, FlistImageReferences>
): string[] {
  let live = 0
  let snapshots = 0
  const inSets = new Map<string, number>()
  for (const id of imageIds) {
    const r = refs[id]
    if (!r) continue
    if (r.live) live++
    if (r.snapshots > 0) snapshots++
    for (const name of r.working_sets) inSets.set(name, (inSets.get(name) ?? 0) + 1)
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
  for (const [name, n] of inSets) {
    notes.push(`${howMany(n)} ${is(n)} still used in the working set “${name}”.`)
  }
  if (snapshots > 0) {
    notes.push(
      `${howMany(snapshots)} ${one || snapshots === 1 ? 'appears' : 'appear'} in earlier pulls (snapshots).`
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
