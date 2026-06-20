import { describe, expect, it } from 'vitest'
import { findEnclosingTag } from './findEnclosingTag'

describe('findEnclosingTag', () => {
  it('returns null when no tag wraps the position', () => {
    expect(findEnclosingTag('hello world', 5)).toBeNull()
  })

  it('finds a simple wrap', () => {
    //         0123456789012345
    const src = '[b]hello[/b]'
    const t = findEnclosingTag(src, 5)
    expect(t).not.toBeNull()
    expect(t!.name).toBe('b')
    expect(t!.openStart).toBe(0)
    expect(t!.openEnd).toBe(3)
    expect(t!.closeStart).toBe(8)
    expect(t!.closeEnd).toBe(12)
  })

  it('returns innermost pair when nested', () => {
    //         0  3  6        14 17
    const src = '[b][i]hello[/i][/b]'
    const t = findEnclosingTag(src, 8)
    expect(t!.name).toBe('i')
  })

  it('targets outer when click is on the open of inner outer tag', () => {
    const src = '[b]outer [i]inner[/i] more[/b]'
    // pos 1 is inside the [b] open tag itself; that's "outer"
    const t = findEnclosingTag(src, 1)
    expect(t!.name).toBe('b')
  })

  it('handles attribute-bearing open tags like [color=red]', () => {
    const src = '[color=red]x[/color]'
    const t = findEnclosingTag(src, 11)
    expect(t!.name).toBe('color')
    expect(t!.openEnd).toBe('[color=red]'.length)
  })

  it('ignores self-closing tags (hr, br)', () => {
    const src = '[hr][b]x[/b]'
    const t = findEnclosingTag(src, 7)
    expect(t!.name).toBe('b')
  })

  it('skips orphan closing tags', () => {
    const src = '[b]x[/i][/b]'
    const t = findEnclosingTag(src, 3)
    expect(t!.name).toBe('b')
  })

  it('case-insensitive tag names', () => {
    const src = '[B]x[/b]'
    const t = findEnclosingTag(src, 3)
    expect(t!.name).toBe('b')
  })

  it('returns null when position is outside the pair', () => {
    const src = '[b]x[/b] after'
    expect(findEnclosingTag(src, 10)).toBeNull()
  })
})
