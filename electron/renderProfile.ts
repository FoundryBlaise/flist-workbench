import { BrowserWindow } from 'electron'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { bbcodeToHtml } from '../renderer/src/lib/bbcode'
import type { InlinesManifest } from '../renderer/src/lib/bbcode'

/** Render a profile description to a PNG, the way the preview pane
 *  shows it.
 *
 *  This exists so a model driving Workbench over MCP can look at what
 *  it just wrote. BBCode is not a format anyone reads accurately in
 *  their head — a stray [/color], a collapse that swallowed half the
 *  page, an image that 404s — and "describe the markup back to me"
 *  does not catch any of that. A picture does.
 *
 *  It runs in the main process rather than the sidecar because the
 *  sidecar is a frozen Python binary: giving it a browser engine would
 *  mean shipping one. Electron already is one. `bbcodeToHtml` is a
 *  pure string function, so main can call it directly and never
 *  involve the visible window.
 *
 *  Fidelity comes from reusing the app's own stylesheet rather than a
 *  hand-copied subset: the offscreen document carries the same
 *  `pane preview` / `pane-body preview-body` classes and the same
 *  `data-flist-theme`, so what the model sees and what the user sees
 *  in the preview pane cannot drift apart.
 */

export type RenderTheme = 'dark' | 'default' | 'light'

export type RenderProfileOptions = {
  bbcode: string
  inlines?: InlinesManifest
  theme?: RenderTheme
  /** CSS pixels. The preview pane is usually narrower than this; 900
   *  is close to what f-list.net gives a profile on a desktop. */
  width?: number
  /** Safety net for a profile that renders into something enormous —
   *  a runaway [img] or a thousand blank lines. */
  maxHeight?: number
  /** Re-encode as JPEG above this many bytes. A full profile with
   *  inline art renders to megabytes of PNG, and the picture travels
   *  to the model as base64 inside a tool result — a third larger
   *  again. Past a point the response is refused or truncated and the
   *  model sees nothing at all, which is worse than a slightly soft
   *  JPEG. */
  pngByteBudget?: number
}

export type RenderedImage = {
  bytes: Buffer
  /** "image/png" or "image/jpeg" — the caller has to say which. */
  mime: string
  width: number
  height: number
}

let cachedCss: string | null = null

/** The built renderer stylesheet, inlined into the offscreen document.
 *  In dev there is no built CSS (vite serves it), so callers fall back
 *  to a bare document — good enough for a dev smoke test, and the
 *  packaged app always has the file. */
async function rendererCss(): Promise<string> {
  if (cachedCss !== null) return cachedCss
  const assets = join(__dirname, '../renderer/assets')
  try {
    const names = await readdir(assets)
    const css = names.filter((n) => n.endsWith('.css'))
    const parts = await Promise.all(
      css.map((n) => readFile(join(assets, n), 'utf8'))
    )
    cachedCss = parts.join('\n')
  } catch {
    cachedCss = ''
  }
  return cachedCss
}

function escapeForDoc(html: string): string {
  // The body is injected into a <script>-free document, but a source
  // string containing "</script>" would still break out of nothing —
  // we build the document as a data: URL, so only the URL encoding
  // matters. Kept as a seam in case this ever becomes a file.
  return html
}

export async function renderProfileToPng(
  opts: RenderProfileOptions
): Promise<RenderedImage> {
  const width = Math.max(320, Math.min(2000, Math.round(opts.width ?? 900)))
  const maxHeight = Math.max(400, Math.min(20000, opts.maxHeight ?? 8000))
  const theme: RenderTheme = opts.theme ?? 'dark'
  const body = escapeForDoc(
    bbcodeToHtml(opts.bbcode, { inlines: opts.inlines })
  )
  const css = await rendererCss()

  const doc = `<!doctype html>
<html><head><meta charset="utf-8">
<style>${css}</style>
<style>
  /* The preview pane is a flex child inside the app shell; here it is
     the whole document, so it has to size itself. Height auto, and the
     capture is cropped to the measured content. */
  html, body { margin: 0; padding: 0; background: transparent; }
  .pane.preview { display: block; width: ${width}px; }
  .pane.preview .pane-body { overflow: visible; }
</style>
</head>
<body>
  <div class="pane preview" data-flist-theme="${theme}">
    <div class="pane-body preview-body" id="body">${body}</div>
  </div>
</body></html>`

  const win = new BrowserWindow({
    width,
    height: 600,
    show: false,
    webPreferences: {
      offscreen: true,
      // Nothing in the document is ours to trust: it is the user's
      // profile text. No preload, no node, no IPC.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      javascript: true
    }
  })

  try {
    await win.loadURL(
      'data:text/html;charset=utf-8,' + encodeURIComponent(doc)
    )
    // Images (avatars, eicons, inlines) come off f-list's CDN and are
    // not covered by 'did-finish-load'. Wait for them, but never
    // longer than a few seconds — a dead CDN must not hang the tool,
    // and a profile with a broken image should still produce a
    // picture showing it broken.
    const measured = await win.webContents.executeJavaScript(
      `(async () => {
         const imgs = Array.from(document.images);
         await Promise.race([
           Promise.all(imgs.map((i) => i.complete
             ? null
             : new Promise((r) => { i.addEventListener('load', r); i.addEventListener('error', r); }))),
           new Promise((r) => setTimeout(r, 4000))
         ]);
         const el = document.getElementById('body');
         const rect = el.getBoundingClientRect();
         return Math.ceil(rect.height);
       })()`,
      true
    )
    const height = Math.max(
      40,
      Math.min(maxHeight, Number(measured) || 600)
    )
    win.setContentSize(width, height)
    // One frame to settle the resize before the capture.
    await new Promise((r) => setTimeout(r, 120))
    const image = await win.webContents.capturePage()
    const png = image.toPNG()
    const budget = opts.pngByteBudget ?? 1_200_000
    if (png.byteLength <= budget) {
      return { bytes: png, mime: 'image/png', width, height }
    }
    // Text stays legible at this quality; the photographs that made it
    // large in the first place are what compresses away.
    return {
      bytes: image.toJPEG(82),
      mime: 'image/jpeg',
      width,
      height
    }
  } finally {
    win.destroy()
  }
}
