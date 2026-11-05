// The kink list both views build from a payload: the Workbench's Kinks
// tab and the Foreign profile view bucket it by choice.

import { expect, it } from 'vitest'
import { bucketByChoice, buildUnifiedKinks } from '../kinksUnified'

const MAPPING = {
  kinks: [
    { id: 12, name: 'Biting', description: '', group_id: 3 },
    { id: 13, name: 'Vore', description: '', group_id: 3 },
    { id: 14, name: 'Untouched', description: '', group_id: 3 }
  ],
  kink_groups: [{ id: 3, name: 'Body' }]
}

const names = (entries: { name: string }[]) => entries.map((e) => e.name)

it('a kink with no choice, or one marked undecided, lands in the undecided bucket', () => {
  const payload = {
    kinks: { '12': 'fave', '13': 'undecided' },
    custom_kinks: {
      '7': { name: 'Invented', description: '', choice: 'undecided' },
      '8': { name: 'Chosen', description: '', choice: 'yes' }
    }
  }

  const buckets = bucketByChoice(buildUnifiedKinks({ payload }, MAPPING))

  expect(names(buckets.undecided)).toEqual(['Vore', 'Untouched', 'Invented'])
  expect(names(buckets.fave)).toEqual(['Biting'])
  expect(names(buckets.yes)).toEqual(['Chosen'])
  expect(buckets.maybe).toEqual([])
  expect(buckets.no).toEqual([])
})
