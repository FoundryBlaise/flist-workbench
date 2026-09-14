/** Re-render the preview without moving the reader.
 *
 *  The preview is repainted by replacing its innerHTML, and replacing
 *  the contents of a scroll container throws the scroll position away:
 *  the browser has nothing left to anchor it to and lands at the top.
 *  Typing one character at the bottom of a long profile therefore
 *  yanked the preview back to the first line, every keystroke.
 *
 *  The rule this implements:
 *
 *  - never scroll up on its own — whatever the reader was looking at
 *    stays where it was;
 *  - follow downward only when the view was already at the bottom, so
 *    text appended at the end keeps showing;
 *  - if the document got shorter than the old position, sit at the new
 *    end rather than somewhere impossible.
 *
 *  Nothing here decides *when* to re-render; it only makes a re-render
 *  invisible to someone reading.
 */

/** How close to the end still counts as "at the bottom". Sub-pixel
 *  layout and fractional zoom mean the arithmetic rarely lands on a
 *  clean zero. */
const BOTTOM_SLACK_PX = 4

export type ScrollBox = {
  scrollTop: number
  readonly scrollHeight: number
  readonly clientHeight: number
}

export function isAtBottom(el: ScrollBox): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK_PX
}

/** Run `write` — which is expected to replace the element's content —
 *  and put the scroll position back where the reader had it. */
export function writeKeepingScroll(el: ScrollBox, write: () => void): void {
  const before = el.scrollTop
  const wasAtBottom = isAtBottom(el)

  write()

  // Read after the write: the new content decides how far it can go.
  const furthest = Math.max(0, el.scrollHeight - el.clientHeight)
  el.scrollTop = wasAtBottom ? furthest : Math.min(before, furthest)
}
