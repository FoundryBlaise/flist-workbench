import { describe, it, expect } from 'vitest'
import { displayPartner } from './partnerName'

describe('displayPartner', () => {
  it('title-cases lowercase names', () => {
    expect(displayPartner('aina sato')).toBe('Aina Sato')
    expect(displayPartner('antiquill')).toBe('Antiquill')
  })

  it('preserves existing title-cased names', () => {
    expect(displayPartner('Aina Sato')).toBe('Aina Sato')
  })

  it('preserves the # prefix on channel names', () => {
    expect(displayPartner('#german ooc')).toBe('#German Ooc')
  })

  it('renders ADH hex channel hashes verbatim (case-significant)', () => {
    // Regression for QA #4: the previous guard `!/[a-z]/.test(name)` never
    // matched a hex hash (always contains lowercase) so these were being
    // title-cased into something like "#Adh-0a1b2c3d...".
    expect(displayPartner('#adh-0a1b2c3d4e5f60718293')).toBe('#adh-0a1b2c3d4e5f60718293')
    expect(displayPartner('#adh-f9e8d7c6b5a4f3e2d1c0')).toBe('#adh-f9e8d7c6b5a4f3e2d1c0')
    expect(displayPartner('#adh-1234abcd5678ef901234')).toBe('#adh-1234abcd5678ef901234')
  })

  it('returns names without any lowercase letters verbatim', () => {
    expect(displayPartner('XYZ')).toBe('XYZ')
  })
})
