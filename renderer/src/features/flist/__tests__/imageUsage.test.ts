import { describe, expect, it } from 'vitest'
import type { FlistImageReferences } from '../../../lib/api'
import { formatBytes, usageNotes } from '../imageUsage'

const ref = (r: Partial<FlistImageReferences>): FlistImageReferences => ({
  working_sets: [],
  live: false,
  snapshots: 0,
  newest_snapshot: null,
  ...r
})

describe('usageNotes', () => {
  it('says nothing about images used nowhere else', () => {
    expect(usageNotes(['a', 'b'], { a: ref({}) })).toEqual([])
  })

  it('counts how many of a batch are still on the live profile', () => {
    const refs = {
      a: ref({ live: true, snapshots: 2 }),
      b: ref({ live: true, snapshots: 1 }),
      c: ref({ live: true }),
      d: ref({})
    }
    expect(usageNotes(['a', 'b', 'c', 'd'], refs)).toEqual([
      '3 of these are on the live profile — the next pull fetches them again.',
      '2 of these appear in earlier pulls (snapshots).'
    ])
  })

  it('names the working set an image is still used in', () => {
    const refs = { a: ref({ working_sets: ['Spring look'] }) }
    expect(usageNotes(['a'], refs)).toEqual([
      'It is still used in the working set “Spring look”.'
    ])
  })
})

describe('formatBytes', () => {
  it('reads like the file sizes F-list talks about', () => {
    expect(formatBytes(2_400_000)).toBe('2.4 MB')
    expect(formatBytes(48_200)).toBe('48 KB')
    expect(formatBytes(512)).toBe('512 B')
  })
})
