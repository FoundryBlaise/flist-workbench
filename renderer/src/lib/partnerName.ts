// F-Chat writes partner / channel directory names lower-cased. Display
// them title-cased so they match the message-row author names — EXCEPT
// for ad-hoc channel hashes like `#adh-bbec48e1537743c7b4d0`. Those
// are case-significant identifiers, not human names, so render verbatim.

const ADH_PREFIX = /^#adh-/i

export function displayPartner(name: string): string {
  if (ADH_PREFIX.test(name)) return name
  if (!/[a-z]/.test(name)) return name
  return name.replace(/\b([a-z])([a-z]*)/g, (_m, h: string, t: string) => h.toUpperCase() + t)
}

// F-Chat stores character directory names lower-cased; show them
// title-cased everywhere they appear in UI chrome (picker, title bar,
// document subtitles) so users see consistent capitalisation.
export function displayCharacter(name: string): string {
  return name.replace(/\b([a-z])([a-z]*)/g, (_m, h: string, t: string) => h.toUpperCase() + t)
}
