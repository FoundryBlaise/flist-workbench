// Entry point exposed to the harness page as window.FCHAT.
//
// The vendored bbcode/ files come from f-list/chat3client (MIT). We
// instantiate the StandardBBCodeParser and feed it a fake "inlines"
// table so [img=ID] tags resolve to an inline image. F-list keeps the
// real per-character inline manifest on the profile page; we don't have
// access to it without auth, so we stub a placeholder image of the
// matching ID so the layout still flows.
import { StandardBBCodeParser } from './standard'

type InlineMap = { [k: string]: { hash: string; extension: string; nsfw: boolean; name?: string } }

export function renderFListBBCode(
  source: string,
  root: HTMLElement,
  inlines?: InlineMap
): void {
  const parser = new StandardBBCodeParser()
  parser.inlines = (inlines ?? {}) as unknown as typeof parser.inlines

  const rendered = parser.parseEverything(source)
  root.innerHTML = ''
  rendered.classList.add('bbcode')
  root.appendChild(rendered)
}
