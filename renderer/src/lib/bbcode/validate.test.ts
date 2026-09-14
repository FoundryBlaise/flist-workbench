// Every case here was run through F-list's own parser in the browser
// —`FList.TagParser.enableWarnings(); parseEverything(htmlentities(s))`
// on f-list.net — and this file asserts the same verdicts. Guessing at
// these rules is how the app ends up disagreeing with the site, which
// is worse than not checking at all: a false "looks fine" is what sent
// the user to the upload in the first place.

import { expect, it } from 'vitest'
import { validateBbcode } from './validate'

const tags = (s: string) => validateBbcode(s).map((w) => w.tag)

it('accepts one level of formatting inside [big]', () => {
  expect(tags('[big][b]X[/b][/big]')).toEqual([])
  expect(tags('[big][color=cyan]X[/color][/big]')).toEqual([])
  expect(tags('[big][i]X[/i][/big]')).toEqual([])
})

it('refuses a second level inside [big]', () => {
  // The shape everyone reaches for when they want a large, bold,
  // coloured heading — and the one F-list rejects.
  expect(tags('[big][b][color=cyan]X[/color][/b][/big]')).toEqual(['color'])
  expect(tags('[big][color=cyan][b]X[/b][/color][/big]')).toEqual(['b'])
})

it('takes the same heading with the colour on the outside', () => {
  expect(tags('[color=cyan][big][b]X[/b][/big][/color]')).toEqual([])
})

it('leaves ordinary nesting alone', () => {
  expect(tags('[b][color=cyan]X[/color][/b]')).toEqual([])
  expect(tags('[color=gray][sub]Y[/sub][/color]')).toEqual([])
  expect(tags('[center][b][i]X[/i][/b][/center]')).toEqual([])
})

it('holds [sub] and [sup] to bold, italic and underline', () => {
  expect(tags('[sub][b]Y[/b][/sub]')).toEqual([])
  expect(tags('[sub][color=gray]Y[/color][/sub]')).toEqual(['color'])
  expect(tags('[sup][s]Y[/s][/sup]')).toEqual(['s'])
})

it('lets nothing inside [url], [icon] or [noparse]', () => {
  expect(tags('[url=https://example.com][b]X[/b][/url]')).toEqual(['b'])
  expect(tags('[icon][b]Name[/b][/icon]')).toEqual(['b'])
  // Inside noparse everything is literal text, so nothing is judged.
  expect(tags('[noparse][big][b][color=red]X[/color][/b][/big][/noparse]')).toEqual([])
})

it('says which tag and where, the way the site does', () => {
  const [w] = validateBbcode('hello [big][b][color=cyan]X[/color][/b][/big]')
  expect(w.tag).toBe('color')
  expect(w.start).toBe('hello [big][b]'.length)
  expect(w.message).toContain('The [color] tag is not allowed here')
})

it('ignores tags F-list does not know', () => {
  // Its parser leaves them as literal text without complaint.
  expect(tags('[big][blink]X[/blink][/big]')).toEqual([])
})

it('has nothing to say about plain text', () => {
  expect(validateBbcode('Just a description, no markup at all.')).toEqual([])
})
