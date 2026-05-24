// Stubs for the two `'../site/utils'` / `'../interfaces'` imports that
// F-list's bbcode/standard.ts pulls in. We only need enough of the
// surface area for the parser to render a static page; we don't run the
// click handlers, settings, or inline-image lookup.

export const staticDomain = 'https://static.f-list.net/'
export const siteDomain = 'https://www.f-list.net/'

export enum InlineDisplayMode {
  DISPLAY_ALL = 0,
  DISPLAY_SFW = 1,
  DISPLAY_NONE = 2
}

export interface InlineImage {
  hash: string
  extension: string
  nsfw: boolean
  name: string
}

export const settings = {
  inlineDisplayMode: InlineDisplayMode.DISPLAY_ALL,
  animateEicons: true
}
