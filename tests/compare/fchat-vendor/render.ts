// Entry point exposed to the harness page as window.FCHAT.
//
// The vendored bbcode/ files come from f-list/chat3client (MIT). We
// instantiate the StandardBBCodeParser and feed it a fake "inlines"
// table so [img=ID] tags resolve to an inline image. F-list keeps the
// real per-character inline manifest on the profile page; we don't have
// access to it without auth, so we stub a placeholder image of the
// matching ID so the layout still flows.
import { StandardBBCodeParser } from './standard'
import { InlineDisplayMode } from './stubs'

export function renderFListBBCode(source: string, root: HTMLElement): void {
  const parser = new StandardBBCodeParser()
  // Synthesize an inlines table on demand so [img=N] always resolves.
  parser.inlines = new Proxy({}, {
    get(_t, key: string) {
      if (!/^\d+$/.test(key)) return undefined
      return {
        // Pad to keep substr(0,2)/substr(2,2) happy; use a deterministic
        // placeholder hash so the image src stays stable.
        hash: ('00000000' + key).slice(-32).padStart(32, '0'),
        extension: 'png',
        nsfw: false,
        name: 'placeholder'
      }
    }
  }) as unknown as { [k: string]: { hash: string; extension: string; nsfw: boolean; name: string } }
  // Force inline-display "all" so we don't get the click-to-load shim.
  ;(globalThis as unknown as { __settings?: unknown }).__settings = { inlineDisplayMode: InlineDisplayMode.DISPLAY_ALL }

  const rendered = parser.parseEverything(source)
  root.innerHTML = ''
  rendered.classList.add('bbcode')
  root.appendChild(rendered)
}
