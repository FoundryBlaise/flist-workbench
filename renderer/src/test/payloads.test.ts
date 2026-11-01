import { describe, expect, it } from 'vitest'
import { WORKING_SCHEMA_VERSION, applyEdit, pathLookup } from '../state/flist'
import {
  archiveEntry,
  livePayload,
  payloadRead,
  workbenchPayload,
  workbenchRead,
  workingSlot
} from './payloads'

describe('workbenchPayload', () => {
  it('is an untouched Workbench of the current schema by default', () => {
    expect(workbenchPayload()).toEqual({
      _schema_version: WORKING_SCHEMA_VERSION,
      _overlay: [],
      character: { description: '' }
    })
  })

  it('takes top-level overrides, replacing what it would default', () => {
    const p = workbenchPayload({
      character: { description: 'Azure Viper, edited' },
      _overlay: ['character.description'],
      images: []
    })
    expect(p.character).toEqual({ description: 'Azure Viper, edited' })
    expect(p._overlay).toEqual(['character.description'])
    expect(p.images).toEqual([])
    expect(p._schema_version).toBe(WORKING_SCHEMA_VERSION)
  })

  it('hands out a fresh object every call, so one test cannot edit another', () => {
    const a = workbenchPayload()
    ;(a.character as { description: string }).description = 'changed'
    a._overlay!.push('character.description')
    expect(workbenchPayload()).toEqual({
      _schema_version: WORKING_SCHEMA_VERSION,
      _overlay: [],
      character: { description: '' }
    })
  })
})

describe('livePayload', () => {
  it('is a pulled profile with an empty description by default', () => {
    expect(livePayload()).toEqual({ character: { description: '' } })
  })

  it('takes overrides', () => {
    expect(livePayload({ character: { description: 'live' }, images: [] })).toEqual({
      character: { description: 'live' },
      images: []
    })
  })
})

describe('workingSlot', () => {
  it('is a saved, materialised slot whose overlay mirrors the payload', () => {
    const slot = workingSlot(workbenchPayload({ _overlay: ['character.description'] }))
    expect(slot).toMatchObject({
      overlay: ['character.description'],
      etag: 'seed-etag',
      unsavedDirty: false,
      saveStatus: 'idle',
      saveError: null,
      materialised: true
    })
  })

  it('takes slot overrides', () => {
    const slot = workingSlot(workbenchPayload(), { etag: null, materialised: false })
    expect(slot.etag).toBeNull()
    expect(slot.materialised).toBe(false)
  })

  it('is a slot the store edits like any other', () => {
    const edited = applyEdit(workingSlot(), 'character.description', 'typed')
    expect(edited.unsavedDirty).toBe(true)
    expect(pathLookup(edited.payload, 'character.description')).toBe('typed')
  })
})

describe('sidecar replies', () => {
  it('archiveEntry wraps a Live with no Backups, idle', () => {
    expect(archiveEntry(livePayload())).toEqual({
      live: { character: { description: '' } },
      snapshots: [],
      pullStatus: 'idle'
    })
  })

  it('payloadRead is what reading a Workbench payload returns', () => {
    expect(payloadRead(workbenchPayload(), 'e1')).toEqual({
      payload: workbenchPayload(),
      etag: 'e1'
    })
  })

  it('workbenchRead names the bench and makes it active', () => {
    expect(workbenchRead('bbbbbbbbbbbb')).toEqual({
      workbench: { id: 'bbbbbbbbbbbb', kind: 'bench', name: 'Workbench' },
      active_set_id: 'bbbbbbbbbbbb'
    })
  })
})
