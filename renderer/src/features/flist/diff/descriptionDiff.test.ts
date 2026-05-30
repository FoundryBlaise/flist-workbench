import { describe, expect, it } from 'vitest'
import { descriptionDiff, DESC_DIFF_BYTE_CAP } from './descriptionDiff'

describe('descriptionDiff', () => {
  it('returns identical=true for matching input', () => {
    const out = descriptionDiff('same', 'same')
    expect(out.identical).toBe(true)
    expect(out.hasChanges).toBe(false)
    expect(out.lines.length).toBe(0)
  })

  it('emits one rem + one add for a single-line edit', () => {
    const out = descriptionDiff('hello', 'world')
    expect(out.hasChanges).toBe(true)
    const kinds = out.lines.map((l) => l.kind)
    expect(kinds).toEqual(['rem', 'add'])
    expect(out.lines[0].text).toBe('hello')
    expect(out.lines[1].text).toBe('world')
  })

  it('normalises CRLF input so different line endings do not flag', () => {
    const out = descriptionDiff('a\r\nb', 'a\nb')
    expect(out.identical).toBe(true)
    expect(out.hasChanges).toBe(false)
  })

  it('preserves common prefix/suffix as `eq` lines', () => {
    const left = 'alpha\nbeta\ngamma'
    const right = 'alpha\nBETA\ngamma'
    const out = descriptionDiff(left, right)
    expect(out.lines.map((l) => l.kind)).toEqual(['eq', 'rem', 'add', 'eq'])
    const eqLines = out.lines.filter((l) => l.kind === 'eq').map((l) => l.text)
    expect(eqLines).toEqual(['alpha', 'gamma'])
  })

  it('tracks 1-indexed line numbers per side', () => {
    const out = descriptionDiff('a\nb', 'a\nB\nc')
    const map = out.lines.map((l) => [l.kind, l.leftLine, l.rightLine])
    // eq a (L1, R1), rem b (L2, -), add B (-, R2), add c (-, R3)
    expect(map).toEqual([
      ['eq', 1, 1],
      ['rem', 2, null],
      ['add', null, 2],
      ['add', null, 3]
    ])
  })

  it('exposes the longer byte length for the renderer perf cap', () => {
    const left = 'short'
    const right = 'this side is the longer one'
    const out = descriptionDiff(left, right)
    expect(out.longerBytes).toBe(right.length)
  })

  it('cap constant is documented and reasonable for renderer perf', () => {
    expect(DESC_DIFF_BYTE_CAP).toBeGreaterThanOrEqual(5_000)
    expect(DESC_DIFF_BYTE_CAP).toBeLessThanOrEqual(50_000)
  })

  it('bails early on pathological inputs that would blow the LCS memory budget', () => {
    // Each line is 2 chars + LF so a 4k-line side fits well under the
    // 10 KB byte cap but the LCS table would be ~16M cells.
    const linesA = Array.from({ length: 4000 }, (_, i) => `A${i}`).join('\n')
    const linesB = Array.from({ length: 4000 }, (_, i) => `B${i}`).join('\n')
    const out = descriptionDiff(linesA, linesB)
    // The engine should have skipped the LCS allocation and reported
    // "diff present but suppressed" so the view falls through to its
    // suppressed-for-length branch.
    expect(out.hasChanges).toBe(true)
    expect(out.identical).toBe(false)
    expect(out.lines.length).toBe(0)
  })

  it('runs under 100 ms on a ~500-line description (perf smoke)', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')
    const edited = lines.replace('line 250', 'line 250 edited')
    const start = performance.now()
    const out = descriptionDiff(lines, edited)
    const elapsed = performance.now() - start
    expect(out.hasChanges).toBe(true)
    expect(elapsed).toBeLessThan(100)
  })
})
