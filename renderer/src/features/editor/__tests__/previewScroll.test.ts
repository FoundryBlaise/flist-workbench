// Reported from the field: "typing on the left scrolls the preview
// back to the top, wherever I am in the document". Replacing the
// innerHTML of a scroll container is what does it — the browser has
// nothing to anchor to and lands at zero.
//
// jsdom has no layout, so these drive a stand-in with the three numbers
// that matter. The arithmetic is the part that can be wrong.

import { describe, expect, it } from 'vitest'
import { isAtBottom, writeKeepingScroll } from '../previewScroll'

function box(scrollTop: number, scrollHeight: number, clientHeight = 500) {
  return { scrollTop, scrollHeight, clientHeight }
}

describe('re-rendering the preview', () => {
  it('leaves the reader where they were', () => {
    const el = box(1200, 4000)
    writeKeepingScroll(el, () => {})
    expect(el.scrollTop).toBe(1200)
  })

  it('never scrolls up, even when the document grows', () => {
    const el = box(1200, 4000)
    writeKeepingScroll(el, () => {
      ;(el as { scrollHeight: number }).scrollHeight = 4200
    })
    expect(el.scrollTop).toBe(1200)
  })

  it('follows the end when it was already at the end', () => {
    // Someone typing at the bottom of the profile wants to keep seeing
    // what they type.
    const el = box(3500, 4000)
    expect(isAtBottom(el)).toBe(true)
    writeKeepingScroll(el, () => {
      ;(el as { scrollHeight: number }).scrollHeight = 4100
    })
    expect(el.scrollTop).toBe(3600)
  })

  it('does not follow the end from the middle', () => {
    const el = box(1000, 4000)
    writeKeepingScroll(el, () => {
      ;(el as { scrollHeight: number }).scrollHeight = 6000
    })
    expect(el.scrollTop).toBe(1000)
  })

  it('settles at the new end when the document shrinks past it', () => {
    const el = box(3000, 4000)
    writeKeepingScroll(el, () => {
      ;(el as { scrollHeight: number }).scrollHeight = 900
    })
    expect(el.scrollTop).toBe(400)
  })

  it('stays at zero for a document shorter than the pane', () => {
    const el = box(0, 200)
    writeKeepingScroll(el, () => {})
    expect(el.scrollTop).toBe(0)
  })

  it('counts a few pixels short of the end as the end', () => {
    // Fractional zoom and sub-pixel layout rarely land on a clean zero.
    expect(isAtBottom(box(3497, 4000))).toBe(true)
    expect(isAtBottom(box(3400, 4000))).toBe(false)
  })
})
