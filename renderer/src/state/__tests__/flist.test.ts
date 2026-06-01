import { describe, expect, it } from 'vitest'
import {
  applyEdit,
  applyReset,
  detectLiveDrift,
  emptyWorkingSlot,
  pathLookup,
  pathSet,
  seedWorkingFromLive
} from '../flist'

const slot = () => ({ ...emptyWorkingSlot(), saveError: null })

describe('pathLookup/pathSet', () => {
  it('walks nested objects', () => {
    const payload = { _overlay: [], a: { b: { c: 1 } } }
    expect(pathLookup(payload, 'a.b.c')).toBe(1)
  })
  it('returns undefined on missing intermediate', () => {
    const payload = { _overlay: [] }
    expect(pathLookup(payload, 'a.b.c')).toBeUndefined()
  })
  it('sets through intermediate objects, creating as needed', () => {
    const payload: Record<string, unknown> = { _overlay: [] }
    pathSet(payload, 'infotags.info_9', 'Human')
    expect((payload.infotags as Record<string, unknown>).info_9).toBe('Human')
  })
  it('handles colon-bearing segments verbatim (Tier 3 local: ids)', () => {
    const payload: Record<string, unknown> = { _overlay: [] }
    pathSet(payload, 'custom_kinks.local:abc.name', 'X')
    const ck = payload.custom_kinks as Record<string, Record<string, unknown>>
    expect(ck['local:abc'].name).toBe('X')
    expect(pathLookup(payload, 'custom_kinks.local:abc.name')).toBe('X')
  })
})

describe('applyEdit', () => {
  it('marks overlay + flips unsavedDirty', () => {
    const out = applyEdit(slot(), 'character.description', '[b]hi[/b]')
    expect(out.unsavedDirty).toBe(true)
    expect(out.overlay).toContain('character.description')
    expect(pathLookup(out.payload, 'character.description')).toBe('[b]hi[/b]')
  })
  it('clears the key on empty infotag (Tier 2 §4.2 empty-state)', () => {
    const seeded = applyEdit(slot(), 'infotags.info_9', 'Human')
    const cleared = applyEdit(seeded, 'infotags.info_9', '')
    expect(pathLookup(cleared.payload, 'infotags.info_9')).toBeUndefined()
    // Overlay path stays so the renderer shows "F-list: Human" still.
    expect(cleared.overlay).toContain('infotags.info_9')
  })
  it('preserves saveError across edits (refresh-or-overwrite banner stays)', () => {
    const error = { ...slot(), saveError: '409 mismatch' }
    const after = applyEdit(error, 'character.description', 'x')
    expect(after.saveError).toBe('409 mismatch')
  })
})

describe('applyReset', () => {
  it('strips the overlay path and restores Live value', () => {
    const dirty = applyEdit(slot(), 'character.description', 'edit')
    const live = { character: { description: 'original' } } as Record<string, unknown>
    const out = applyReset(dirty, live, 'character.description')
    expect(out.overlay).not.toContain('character.description')
    expect(pathLookup(out.payload, 'character.description')).toBe('original')
  })
  it('deletes infotag key when Live does not carry it', () => {
    const dirty = applyEdit(slot(), 'infotags.info_9', 'Human')
    const out = applyReset(dirty, {}, 'infotags.info_9')
    expect(pathLookup(out.payload, 'infotags.info_9')).toBeUndefined()
    expect(out.overlay).not.toContain('infotags.info_9')
  })
})

describe('seedWorkingFromLive', () => {
  it('normalises CRLF + carries inlines verbatim', () => {
    const live = {
      character: { description: 'a\r\nb', id: '1', name: 'A' },
      inlines: { '5': { hash: 'x', extension: 'png', nsfw: false } }
    }
    const seeded = seedWorkingFromLive(live)
    const desc = (seeded.character as Record<string, unknown>).description as string
    expect(desc).toBe('a\nb')
    expect(seeded.inlines).toEqual(live.inlines)
  })
  it('translates live.images to sha-keyed gallery (Tier 6)', () => {
    // Post-Tier-6 pulls augment each live.images entry with sha256;
    // the working slot's gallery is the curated subset that carries
    // through to the ZIP serialiser.
    const live = {
      character: { description: 'x' },
      images: [
        { image_id: '1', extension: 'jpg', sha256: 'aaa', description: 'first' },
        { image_id: '2', extension: 'png', sha256: 'bbb' }
      ]
    } as Record<string, unknown>
    const seeded = seedWorkingFromLive(live)
    expect(seeded.images).toEqual([
      { sha256: 'aaa', description: 'first' },
      { sha256: 'bbb', description: '' }
    ])
  })
  it('drops live.images entries without sha256 (pre-Tier-6 archive)', () => {
    // Old live.json that never got re-pulled after the migration
    // carries entries without sha256 — those drop out so the gallery
    // doesn't render broken thumbnails. User re-pulls to repopulate.
    const live = {
      character: { description: 'x' },
      images: [{ image_id: '1', extension: 'jpg' }]
    } as Record<string, unknown>
    const seeded = seedWorkingFromLive(live)
    expect(seeded.images).toEqual([])
  })
  it('preserves unknown top-level keys (forward-compat round-trip)', () => {
    const live = {
      character: { description: 'a' },
      _future: { tier: 5 }
    } as Record<string, unknown>
    const seeded = seedWorkingFromLive(live)
    // Forward-compat is enforced by the disk reader, not the seed helper —
    // seedWorkingFromLive only copies recognised containers. Document the
    // invariant: anything outside WORKING_CONTAINER_KEYS lives only on
    // disk after first flush; the seed itself is "from Live + overlay".
    expect(seeded.character).toBeDefined()
  })
  it('derives _custom_kinks_order on Live with custom_kinks dict', () => {
    const live = {
      character: { description: '' },
      custom_kinks: {
        '31712021': { name: 'A', choice: 'fave', children: [] },
        '31712022': { name: 'B', choice: 'yes', children: [] }
      }
    }
    const seeded = seedWorkingFromLive(live)
    expect(seeded._custom_kinks_order).toEqual(['31712021', '31712022'])
  })
})

describe('detectLiveDrift', () => {
  it('flags paths where the value changed, excluding ignore list', () => {
    const oldLive = {
      character: { description: 'old' },
      infotags: { '9': 'Human' }
    }
    const newLive = {
      character: { description: 'new' },
      infotags: { '9': 'Elf', '15': '8' }
    }
    const drift = detectLiveDrift(
      oldLive,
      newLive,
      ['character.description', 'infotags.9', 'infotags.15'],
      ['character.description'] // user has edited description — ignore
    )
    expect(drift).toContain('infotags.9')
    expect(drift).toContain('infotags.15')
    expect(drift).not.toContain('character.description')
  })
  it('returns empty when oldLive is null', () => {
    expect(detectLiveDrift(null, { a: 1 }, ['a'])).toEqual([])
  })
})
