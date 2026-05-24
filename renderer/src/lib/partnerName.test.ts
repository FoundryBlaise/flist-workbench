import { describe, it, expect } from 'vitest'
import { displayPartner } from './partnerName'

describe('displayPartner', () => {
  it('title-cases lowercase names', () => {
    expect(displayPartner('aiko kato')).toBe('Aiko Kato')
    expect(displayPartner('antifuxxs')).toBe('Antifuxxs')
  })

  it('preserves existing title-cased names', () => {
    expect(displayPartner('Aiko Kato')).toBe('Aiko Kato')
  })

  it('preserves the # prefix on channel names', () => {
    expect(displayPartner('#german ooc')).toBe('#German Ooc')
  })

  it('renders ADH hex channel hashes verbatim (case-significant)', () => {
    // Regression for QA #4: the previous guard `!/[a-z]/.test(name)` never
    // matched a hex hash (always contains lowercase) so these were being
    // title-cased into something like "#Adh-Bbec48e1...".
    expect(displayPartner('#adh-bbec48e1537743c7b4d0')).toBe('#adh-bbec48e1537743c7b4d0')
    expect(displayPartner('#adh-00ea36653e5b354f217e')).toBe('#adh-00ea36653e5b354f217e')
    expect(displayPartner('#adh-c9e72283e5572e57c57a')).toBe('#adh-c9e72283e5572e57c57a')
  })

  it('returns names without any lowercase letters verbatim', () => {
    expect(displayPartner('XYZ')).toBe('XYZ')
  })
})
