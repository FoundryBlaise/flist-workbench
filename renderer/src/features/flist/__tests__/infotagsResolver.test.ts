import { describe, it, expect } from 'vitest'
import { resolveInfotagDescriptors } from '../infotagsResolver'

// Two shapes to test: the dict shape (older proposed schema) and the
// list shape F-list actually publishes today (probe-verified 2026-05-30).
const baseMapping = {
  infotags: [
    { id: 1, name: 'Age', type: 'text', group_id: 'general' },
    {
      id: 9,
      name: 'Species',
      type: 'list',
      list: [
        { id: 10, value: 'Human' },
        { id: 11, value: 'Elf' }
      ],
      group_id: 'general'
    },
    { id: 15, name: 'Height', type: 'number', group_id: 'general' },
    { id: 99, name: 'Mystery', type: 'unfamiliar-type' }
  ],
  listitems: [],
  infotag_groups: {
    general: { label: 'General' },
    sexual: { name: 'Sexual details' }
  }
}

// Probe-shape fixture — `infotag_groups` as list, `list` as a string
// referencing listitems by category name.
const realMapping = {
  infotags: [
    { id: '1', name: 'Age', type: 'text', list: '', group_id: '3' },
    { id: '2', name: 'Orientation', type: 'list', list: 'orientation', group_id: '3' }
  ],
  listitems: [
    { id: '4', name: 'orientation', value: 'Straight' },
    { id: '5', name: 'orientation', value: 'Gay' }
  ],
  infotag_groups: [
    { id: '3', name: 'General details' },
    { id: '5', name: 'RPing preferences' }
  ]
}

describe('resolveInfotagDescriptors', () => {
  it('classifies field types and falls back to text on empty list', () => {
    const out = resolveInfotagDescriptors({
      ...baseMapping,
      infotags: [
        ...baseMapping.infotags,
        { id: 7, name: 'EmptyList', type: 'list', list: [] }
      ]
    })
    const byId = out.byId
    expect(byId.get('1')?.type).toBe('text')
    expect(byId.get('9')?.type).toBe('list')
    expect(byId.get('15')?.type).toBe('number')
    expect(byId.get('99')?.type).toBe('unknown')
    expect(byId.get('7')?.type).toBe('text')
  })

  it('routes list values through listitems when payload is sparse', () => {
    const out = resolveInfotagDescriptors({
      infotags: [
        { id: 9, name: 'Species', type: 'list', list: [55, 56] }
      ],
      listitems: [
        { id: 55, value: 'Human' },
        { id: 56, value: 'Elf' }
      ]
    })
    const species = out.byId.get('9')
    expect(species?.listItems?.map((i) => i.label)).toEqual(['Human', 'Elf'])
  })

  it('surfaces unknown ids from overlay + payload in the unknown bucket', () => {
    const out = resolveInfotagDescriptors(baseMapping, {
      overlay: ['infotags.500'],
      infotagsPayload: { '500': '?', '99': '?' }
    })
    const unknownIds = out.unknownGroup.descriptors.map((d) => d.id)
    expect(unknownIds).toContain('99') // type=unknown
    expect(unknownIds).toContain('500') // missing from mapping
  })

  it('attaches groups from mapping.infotag_groups when present', () => {
    const out = resolveInfotagDescriptors(baseMapping)
    const general = out.groups.find((g) => g.id === 'general')
    expect(general?.descriptors.some((d) => d.id === '9')).toBe(true)
  })

  it('falls back to hand-coded groups when payload omits infotag_groups', () => {
    const noGroups = { ...baseMapping, infotag_groups: undefined }
    const out = resolveInfotagDescriptors(noGroups)
    expect(out.groups.length).toBeGreaterThan(0)
    // Hand-coded fallback uses F-list-real group ids (1/2/3/5).
    expect(out.groups.some((g) => g.id === '3')).toBe(true)
  })

  it('resolves the F-list real wire shape (list of {id,name}, list as string)', () => {
    const out = resolveInfotagDescriptors(realMapping)
    expect(out.groups.map((g) => g.id)).toContain('3')
    const orientation = out.byId.get('2')
    expect(orientation?.type).toBe('list')
    expect(orientation?.listItems?.map((i) => i.label)).toEqual(['Straight', 'Gay'])
    const generalGroup = out.groups.find((g) => g.id === '3')
    expect(generalGroup?.descriptors.some((d) => d.id === '1')).toBe(true)
    expect(generalGroup?.descriptors.some((d) => d.id === '2')).toBe(true)
  })
})
