/**
 * Scan BBCode source for the innermost open/close tag pair that wraps
 * `pos`. Returns the byte offsets of both tags so the caller can strip
 * them via a single CodeMirror transaction.
 *
 * Pair matching is LIFO by name — `[b][i]x[/i][/b]` matches each tag
 * to its nearest open. Mismatched tags are skipped (`[b]x[/i][/b]`
 * pairs the `[b]` with the trailing `[/b]`, ignoring the orphan
 * `[/i]`). Self-closing tags (`[hr]`, `[br]`) don't count as
 * containers.
 *
 * Returns the smallest matching pair when the position is nested
 * inside multiple tags, so right-clicking inside `[b][i]foo[/i][/b]`
 * targets the inner `[i]` not the outer `[b]`.
 */
export interface EnclosingTag {
  name: string
  openStart: number
  openEnd: number
  closeStart: number
  closeEnd: number
}

const TAG_RE = /\[(\/?)([a-zA-Z][a-zA-Z0-9]*)(?:=[^\]]*)?\]/g
const SELF_CLOSING = new Set(['hr', 'br'])

export function findEnclosingTag(
  source: string,
  pos: number
): EnclosingTag | null {
  const opens: { name: string; openStart: number; openEnd: number }[] = []
  const pairs: EnclosingTag[] = []
  const re = new RegExp(TAG_RE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(source))) {
    const start = m.index
    const end = start + m[0].length
    const name = m[2].toLowerCase()
    if (SELF_CLOSING.has(name)) continue
    if (m[1]) {
      for (let i = opens.length - 1; i >= 0; i--) {
        if (opens[i].name === name) {
          const open = opens[i]
          pairs.push({
            name,
            openStart: open.openStart,
            openEnd: open.openEnd,
            closeStart: start,
            closeEnd: end
          })
          opens.splice(i, 1)
          break
        }
      }
    } else {
      opens.push({ name, openStart: start, openEnd: end })
    }
  }
  let best: EnclosingTag | null = null
  for (const p of pairs) {
    if (pos < p.openStart || pos > p.closeEnd) continue
    if (!best || p.closeEnd - p.openStart < best.closeEnd - best.openStart) {
      best = p
    }
  }
  return best
}
