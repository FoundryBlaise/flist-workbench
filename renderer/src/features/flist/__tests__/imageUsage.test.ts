import { describe, expect, it } from 'vitest'
import type { FlistImageReferences } from '../../../lib/api'
import { formatBytes, usageNotes } from '../imageUsage'

const ref = (r: Partial<FlistImageReferences>): FlistImageReferences => ({
  workbench: false,
  live: false,
  backups: 0,
  newest_backup: null,
  migration_backup: false,
  ...r
})

describe('usageNotes', () => {
  it('says nothing about images used nowhere else', () => {
    expect(usageNotes(['a', 'b'], { a: ref({}) })).toEqual([])
  })

  it('counts how many of a batch are still on the live profile, and how many a Backup keeps', () => {
    const refs = {
      a: ref({ live: true, backups: 2 }),
      b: ref({ live: true, backups: 1 }),
      c: ref({ live: true }),
      d: ref({})
    }
    expect(usageNotes(['a', 'b', 'c', 'd'], refs)).toEqual([
      '3 of these are on the live profile — the next pull fetches them again.',
      '2 of these are kept in a Backup, which holds its own copy.'
    ])
  })

  it('says when an image is still in the Workbench', () => {
    expect(usageNotes(['a'], { a: ref({ workbench: true }) })).toEqual([
      'It is still in the Workbench’s gallery.'
    ])
  })

  it('says how many Backups keep a single image', () => {
    expect(usageNotes(['a'], { a: ref({ backups: 3 }) })).toEqual([
      'It is kept in 3 Backups, which hold their own copy.'
    ])
    expect(usageNotes(['a'], { a: ref({ backups: 1 }) })).toEqual([
      'It is kept in a Backup, which holds its own copy.'
    ])
  })

  it('warns that the older copies from before the upgrade name an image but hold no copy of it', () => {
    expect(usageNotes(['a'], { a: ref({ migration_backup: true }) })).toEqual([
      'It is named in the older copies from before the upgrade; that Backup holds no copy of the file.'
    ])
    expect(
      usageNotes(['a', 'b'], {
        a: ref({ migration_backup: true }),
        b: ref({ migration_backup: true, backups: 1 })
      })
    ).toEqual([
      '1 of these is kept in a Backup, which holds its own copy.',
      '2 of these are named in the older copies from before the upgrade; that Backup holds no copy of the files.'
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
