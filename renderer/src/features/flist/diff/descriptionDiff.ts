// Line-anchored unified diff for the BBCode description field.
// Char-level diff over BBCode is illegible — tags get shredded — so
// Tier 4 surfaces a line-anchored stack matching the git mental model.
//
// Implementation is a Myers-lite LCS-of-lines walk. The renderer
// `diff` package isn't installed; this is the plan's R-1 fallback,
// under ~60 LOC, no external dep. R-1 perf cap at 10 KB suppresses
// the diff for pathologically long descriptions.

export type DescDiffKind = 'add' | 'rem' | 'eq'

export interface DescDiffLine {
  kind: DescDiffKind
  text: string
  /** 1-indexed line number on the side that contributed this line.
   *  `null` for the empty side of an add/rem. Used by the renderer to
   *  pin a "L37" gutter. */
  leftLine: number | null
  rightLine: number | null
}

export interface DescDiffResult {
  /** True when at least one line differs. */
  hasChanges: boolean
  lines: DescDiffLine[]
  /** Length of the longer side in bytes — used by the renderer to
   *  decide whether to render the unified view or fall back to the
   *  "diff suppressed for length" message. */
  longerBytes: number
  /** True when the diff was suppressed because both sides were
   *  identical strings (cheap short-circuit). */
  identical: boolean
}

/** Normalise CRLF / CR → LF so a Live re-pull with different line
 *  endings doesn't show up as every-line-changed. Tier 2's
 *  `normaliseNewlines` does the same on read; this is defence in
 *  depth for code paths that didn't go through the slice helper. */
function normalise(s: string): string {
  return s.replace(/\r\n?/g, '\n')
}

/** O(N*M) LCS table. Cheap below ~1k×1k lines; the description-diff
 *  perf cap (R-1) keeps inputs well below that. */
function lcsTable(a: string[], b: string[]): number[][] {
  const m = a.length
  const n = b.length
  const table: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0)
  )
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) table[i][j] = table[i + 1][j + 1] + 1
      else table[i][j] = Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  return table
}

/** Quadratic-memory ceiling on the LCS table (QA P3-2). The byte-cap
 *  gates *rendering* in the view; this cap stops a pathological input
 *  (~10 KB × 10 KB with no shared lines) from allocating ~400 MB of
 *  number cells before the renderer suppresses it. */
const DESC_DIFF_LCS_CELL_CAP = 1_000_000

export function descriptionDiff(left: string, right: string): DescDiffResult {
  const a = normalise(left ?? '')
  const b = normalise(right ?? '')
  const longerBytes = Math.max(a.length, b.length)
  if (a === b) {
    return { hasChanges: false, lines: [], longerBytes, identical: true }
  }
  const A = a.split('\n')
  const B = b.split('\n')
  if (A.length * B.length > DESC_DIFF_LCS_CELL_CAP) {
    // Bail before the LCS table allocates. View falls through to the
    // "suppressed for length" branch via the byte-cap on its own.
    return { hasChanges: true, lines: [], longerBytes, identical: false }
  }
  const table = lcsTable(A, B)
  const out: DescDiffLine[] = []
  let i = 0
  let j = 0
  let leftLine = 1
  let rightLine = 1
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) {
      out.push({ kind: 'eq', text: A[i], leftLine, rightLine })
      i++
      j++
      leftLine++
      rightLine++
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      out.push({ kind: 'rem', text: A[i], leftLine, rightLine: null })
      i++
      leftLine++
    } else {
      out.push({ kind: 'add', text: B[j], leftLine: null, rightLine })
      j++
      rightLine++
    }
  }
  while (i < A.length) {
    out.push({ kind: 'rem', text: A[i], leftLine, rightLine: null })
    i++
    leftLine++
  }
  while (j < B.length) {
    out.push({ kind: 'add', text: B[j], leftLine: null, rightLine })
    j++
    rightLine++
  }
  const hasChanges = out.some((l) => l.kind !== 'eq')
  return { hasChanges, lines: out, longerBytes, identical: false }
}

/** Renderer-side guard — Tier 4 R-1: skip the unified view when the
 *  longer side exceeds this many bytes. The renderer falls back to a
 *  "description changed (diff suppressed for length)" note. */
export const DESC_DIFF_BYTE_CAP = 10_000
