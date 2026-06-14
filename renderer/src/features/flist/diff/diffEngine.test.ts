import { describe, expect, it } from 'vitest'
import { computeDiff } from './diffEngine'
import { resolveInfotagDescriptors } from '../infotagsResolver'

const minimalMapping = {
  infotags: [
    { id: '1', name: 'Age', type: 'text', group_id: '3' },
    {
      id: '9',
      name: 'Species',
      type: 'list',
      list: 'orientation',
      group_id: '3'
    }
  ],
  listitems: [
    { id: '10', name: 'orientation', value: 'Human' },
    { id: '11', name: 'orientation', value: 'Elf' }
  ],
  infotag_groups: [{ id: '3', name: 'General' }]
}

function model() {
  return resolveInfotagDescriptors(minimalMapping)
}

function working(p: Record<string, unknown>): Record<string, unknown> {
  return { _schema_version: 2, _overlay: [], ...p }
}

describe('computeDiff — character.description', () => {
  it('flags a description edit as modified', () => {
    const w = working({ character: { description: 'edited' } })
    const r = { character: { description: 'live' } }
    const out = computeDiff(w, r, model(), [])
    const row = out.rows.find((r) => r.path === 'character.description')!
    expect(row.kind).toBe('modified')
    expect(out.changedRowCount).toBeGreaterThanOrEqual(1)
  })

  it('reports unchanged when both sides match', () => {
    const w = working({ character: { description: 'same' } })
    const r = { character: { description: 'same' } }
    const out = computeDiff(w, r, model(), [])
    const row = out.rows.find((r) => r.path === 'character.description')!
    expect(row.kind).toBe('unchanged')
  })

  it('handles right=null (no live yet) as added-everywhere', () => {
    const w = working({ character: { description: 'mine' } })
    const out = computeDiff(w, null, model(), [])
    const row = out.rows.find((r) => r.path === 'character.description')!
    expect(row.kind).toBe('added')
  })
})

describe('computeDiff — infotags', () => {
  it('resolves list-type infotag values to labels', () => {
    const w = working({ infotags: { '9': '10' } })
    const r = { infotags: { '9': '11' } }
    const out = computeDiff(w, r, model(), [])
    const row = out.rows.find((r) => r.path === 'infotags.9')!
    expect(row.workingValue).toBe('Human')
    expect(row.rightValue).toBe('Elf')
    expect(row.kind).toBe('modified')
  })

  it('classifies as removed when working drops a key Live has', () => {
    const w = working({ infotags: {} })
    const r = { infotags: { '1': '28' } }
    const out = computeDiff(w, r, model(), [])
    const row = out.rows.find((r) => r.path === 'infotags.1')!
    expect(row.kind).toBe('removed')
  })

  it('falls back to info_<id> when mapping has no entry', () => {
    const w = working({ infotags: { '500': '?' } })
    const r = { infotags: {} }
    const out = computeDiff(w, r, model(), [])
    const row = out.rows.find((r) => r.path === 'infotags.500')!
    expect(row.label).toBe('info_500')
    expect(row.kind).toBe('added')
  })
})

describe('computeDiff — custom kinks', () => {
  it('flags a tombstoned working kink as modified vs present right', () => {
    const w = working({
      custom_kinks: {
        '111': { name: 'A', description: '', choice: 'no', _deleted: true }
      }
    })
    const r = {
      custom_kinks: { '111': { name: 'A', description: '', choice: 'no' } }
    }
    const out = computeDiff(w, r, model(), [])
    const row = out.rows.find((r) => r.path === 'custom_kinks.111._deleted')!
    expect(row.kind).toBe('modified')
    expect(row.workingValue).toBe('tombstoned')
  })

  it("flags a local: id as added (right doesn't have it)", () => {
    const w = working({
      custom_kinks: {
        'local:abc': { name: 'New', description: '', choice: 'undecided' }
      }
    })
    const r = { custom_kinks: {} }
    const out = computeDiff(w, r, model(), [])
    const row = out.rows.find((r) => r.path === 'custom_kinks.local:abc')!
    expect(row.kind).toBe('added')
  })

  it('walks per-field for a kink present on both sides', () => {
    const w = working({
      custom_kinks: {
        '12': { name: 'Same', description: 'edited', choice: 'fave' }
      }
    })
    const r = {
      custom_kinks: {
        '12': { name: 'Same', description: 'original', choice: 'fave' }
      }
    }
    const out = computeDiff(w, r, model(), [])
    const descRow = out.rows.find((r) => r.path === 'custom_kinks.12.description')!
    const choiceRow = out.rows.find((r) => r.path === 'custom_kinks.12.choice')!
    expect(descRow.kind).toBe('modified')
    expect(choiceRow.kind).toBe('unchanged')
  })
})

describe('computeDiff — standard kinks', () => {
  it('only emits rows for explicit choices on either side (not 559)', () => {
    const w = working({ kinks: { fetish_1: 'fave', fetish_2: 'undecided' } })
    const r = { kinks: { fetish_1: 'undecided', fetish_3: 'yes' } }
    const out = computeDiff(w, r, model(), [
      { id: 'fetish_1', name: 'Kink One' },
      { id: 'fetish_3', name: 'Kink Three' }
    ])
    const kinkRows = out.rows.filter((r) => r.category === 'standard_kink')
    const ids = kinkRows.map((r) => r.path)
    expect(ids).toContain('kinks.fetish_1')
    expect(ids).toContain('kinks.fetish_3')
    expect(ids).not.toContain('kinks.fetish_2')
  })

  it('uses the kink catalogue to resolve labels', () => {
    const w = working({ kinks: { fetish_71: 'fave' } })
    const r = { kinks: { fetish_71: 'no' } }
    const out = computeDiff(w, r, model(), [
      { id: 'fetish_71', name: 'Dirty Talking' }
    ])
    const row = out.rows.find((r) => r.path === 'kinks.fetish_71')!
    expect(row.label).toBe('Dirty Talking')
    expect(row.kind).toBe('modified')
  })
})

describe('computeDiff — empty/missing payload shapes', () => {
  it('handles working.kinks = [] (F-list empty-array shape) without crashing', () => {
    const w = working({ kinks: [] })
    const r = { kinks: { fetish_1: 'fave' } }
    const out = computeDiff(w, r, model(), [{ id: 'fetish_1', name: 'K1' }])
    const row = out.rows.find((r) => r.path === 'kinks.fetish_1')!
    expect(row.kind).toBe('removed')
  })

  it('treats undecided-on-both-sides as unchanged even when overlay tracks the kink', () => {
    // Regression: user toggled a kink, then cleared it back to undecided.
    // Overlay still references kinks.X but both Live and Working now
    // resolve to undecided — the diff used to show this as +added because
    // classify('undecided', undefined) short-circuited before equality.
    const w = working({
      _overlay: ['kinks.fetish_42'],
      kinks: { fetish_42: 'undecided' }
    })
    const r = { kinks: {} }
    const out = computeDiff(w, r, model(), [{ id: 'fetish_42', name: 'K42' }])
    const row = out.rows.find((r) => r.path === 'kinks.fetish_42')!
    expect(row.kind).toBe('unchanged')
    expect(row.workingValue).toBe('undecided')
    expect(row.rightValue).toBe('undecided')
  })

  it('surfaces overlay-only infotag deletions even when both sides are missing the key', () => {
    const w = working({
      _overlay: ['infotags.5'],
      infotags: {}
    })
    const r = { infotags: {} }
    const out = computeDiff(w, r, model(), [])
    const row = out.rows.find((r) => r.path === 'infotags.5')
    expect(row).toBeDefined()
    expect(row?.inOverlay).toBe(true)
    expect(row?.kind).toBe('unchanged')
  })
})

describe('computeDiff — overlay flag', () => {
  it('sets inOverlay only for paths in working._overlay', () => {
    const w = working({
      _overlay: ['character.description', 'infotags.9'],
      character: { description: 'edited' },
      infotags: { '9': '10' }
    })
    const r = { character: { description: 'live' }, infotags: { '9': '11' } }
    const out = computeDiff(w, r, model(), [])
    expect(out.rows.find((r) => r.path === 'character.description')!.inOverlay).toBe(true)
    expect(out.rows.find((r) => r.path === 'character.name')!.inOverlay).toBe(false)
  })
})

describe('computeDiff — counts', () => {
  it('aggregates counts per kind + changedRowCount excludes unchanged', () => {
    const w = working({
      character: { description: 'edited', name: 'Same' },
      infotags: { '1': '28', '9': '10' }
    })
    const r = {
      character: { description: 'edited', name: 'Same' },
      infotags: { '1': '29' }
    }
    const out = computeDiff(w, r, model(), [])
    expect(out.counts.unchanged).toBeGreaterThan(0)
    expect(out.counts.modified).toBeGreaterThanOrEqual(1)
    expect(out.counts.added).toBeGreaterThanOrEqual(1)
    expect(out.changedRowCount).toBe(
      out.counts.modified + out.counts.added + out.counts.removed
    )
  })
})

describe('computeDiff — images', () => {
  const w = (gallery: unknown) =>
    working({ images: gallery, _overlay: ['images'] })

  it('flags an added image when working has it but right does not', () => {
    const wp = w([{ image_id: '42', description: 'hi', sort_order: 0 }])
    const rp = { images: [] }
    const out = computeDiff(wp, rp, model(), [])
    const row = out.rows.find((r) => r.path === 'images.42')
    expect(row?.kind).toBe('added')
    expect(row?.category).toBe('image')
    expect(row?.inOverlay).toBe(true)
  })

  it('flags a removed image when right has it but working does not', () => {
    const wp = w([])
    const rp = { images: [{ image_id: '42', description: '', sort_order: 0 }] }
    const out = computeDiff(wp, rp, model(), [])
    const row = out.rows.find((r) => r.path === 'images.42')
    expect(row?.kind).toBe('removed')
  })

  it('flags a caption change as modified', () => {
    const wp = w([{ image_id: '42', description: 'new', sort_order: 0 }])
    const rp = { images: [{ image_id: '42', description: 'old', sort_order: 0 }] }
    const out = computeDiff(wp, rp, model(), [])
    const row = out.rows.find((r) => r.path === 'images.42')
    expect(row?.kind).toBe('modified')
  })

  it('flags a reorder as modified for both moved images', () => {
    const wp = w([
      { image_id: 'a', description: '', sort_order: 0 },
      { image_id: 'b', description: '', sort_order: 1 }
    ])
    const rp = {
      images: [
        { image_id: 'b', description: '', sort_order: 0 },
        { image_id: 'a', description: '', sort_order: 1 }
      ]
    }
    const out = computeDiff(wp, rp, model(), [])
    const rowA = out.rows.find((r) => r.path === 'images.a')
    const rowB = out.rows.find((r) => r.path === 'images.b')
    expect(rowA?.kind).toBe('modified')
    expect(rowB?.kind).toBe('modified')
  })

  it('unchanged when caption + position match', () => {
    const wp = w([{ image_id: '42', description: 'same', sort_order: 0 }])
    const rp = { images: [{ image_id: '42', description: 'same', sort_order: 0 }] }
    const out = computeDiff(wp, rp, model(), [])
    const row = out.rows.find((r) => r.path === 'images.42')
    expect(row?.kind).toBe('unchanged')
  })
})
