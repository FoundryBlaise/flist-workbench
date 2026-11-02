import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { withApp } from './launch'

// The app window stays the app: nothing a page in it does can take it
// to another page or open another Electron window.

/**
 * Asks the window's own page to go to `url`, the way a link dropped
 * onto the window or a script would, and reports whether the main
 * frame navigated within `ms`.
 */
async function askToNavigate(window: Page, url: string, ms = 3_000): Promise<'navigated' | 'stayed'> {
  const navigated = window
    .waitForEvent('framenavigated', { predicate: (f) => f === window.mainFrame(), timeout: ms })
    .then(
      () => 'navigated' as const,
      () => 'stayed' as const
    )
  await window.evaluate((u) => {
    location.href = u
  }, url)
  return navigated
}

test('the app window stays on the app when asked to load another page', async () => {
  await withApp(async ({ window, dataDir, sidecarUrl }) => {
    const appUrl = window.url()
    // A local page the window could reach in an instant if it were
    // allowed to: a file next to the app's data, and the sidecar itself.
    const dropped = join(dataDir, 'dropped.html')
    await writeFile(dropped, '<!doctype html><title>dropped</title>')

    for (const foreign of [pathToFileURL(dropped).href, `${sidecarUrl}/health`]) {
      expect(await askToNavigate(window, foreign), foreign).toBe('stayed')
    }
    // Read from the page itself: Playwright's locators keep waiting for
    // the cancelled navigation to finish.
    expect(
      await window.evaluate(() => ({
        url: location.href,
        status: document.querySelector('[data-testid="sidecar-status"]')?.textContent ?? ''
      }))
    ).toEqual({ url: appUrl, status: expect.stringContaining('ok') })
  })
})

/**
 * Replaces the shell's external open in the main process with a
 * recorder, so a test sees which URLs would open in the user's browser
 * without opening any. `opened()` lists them in order.
 */
async function stubExternalOpen(app: ElectronApplication): Promise<{ opened: () => Promise<string[]> }> {
  await app.evaluate(({ shell }) => {
    const opened: string[] = []
    ;(globalThis as { __e2eOpened?: string[] }).__e2eOpened = opened
    shell.openExternal = async (url: string) => {
      opened.push(url)
    }
  })
  return {
    opened: () => app.evaluate(() => [...((globalThis as { __e2eOpened?: string[] }).__e2eOpened ?? [])])
  }
}

test('links that open a new window go to the browser, never to a new app window', async () => {
  await withApp(async ({ app, window }) => {
    const { opened } = await stubExternalOpen(app)
    const windowCount = (): Promise<number> =>
      app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
    const before = await windowCount()

    // A target="_blank" link, as the profile preview renders them.
    const clickBlankLink = (href: string): Promise<void> =>
      window.evaluate((h) => {
        const a = document.createElement('a')
        a.href = h
        a.target = '_blank'
        a.rel = 'noreferrer noopener'
        a.textContent = 'link'
        document.body.append(a)
        a.click()
        a.remove()
      }, href)
    const openWindow = (href: string): Promise<void> =>
      window.evaluate((h) => {
        globalThis.open(h)
      }, href)

    // Not web links, so they open nowhere.
    await openWindow('file:///C:/Windows/win.ini')
    await clickBlankLink('javascript:void(0)')
    await openWindow('ftp://files.example.invalid/x')
    // Web links on any host go to the user's browser, as a profile's
    // links point anywhere.
    await openWindow('http://www.f-list.net/c/Plain')
    await clickBlankLink('https://example.invalid/somewhere')
    await openWindow('https://www.f-list.net/c/Opened')

    await expect
      .poll(opened)
      .toEqual([
        'http://www.f-list.net/c/Plain',
        'https://example.invalid/somewhere',
        'https://www.f-list.net/c/Opened'
      ])
    expect(await windowCount()).toBe(before)
  })
})

/**
 * Records, in the main process, whether each request to the sidecar
 * left with the launch secret, keyed by its `probe` query parameter.
 */
async function recordSecret(
  app: ElectronApplication,
  sidecarUrl: string
): Promise<{ seen: () => Promise<Record<string, boolean>> }> {
  await app.evaluate(({ session }, url) => {
    const seen: Record<string, boolean> = {}
    ;(globalThis as { __e2eSecretSeen?: Record<string, boolean> }).__e2eSecretSeen = seen
    session.defaultSession.webRequest.onSendHeaders({ urls: [`${url}/*`] }, (details) => {
      const probe = new URL(details.url).searchParams.get('probe')
      if (!probe) return
      seen[probe] = Object.keys(details.requestHeaders).some((h) => h.toLowerCase() === 'x-workbench-secret')
    })
  }, sidecarUrl)
  return {
    seen: () =>
      app.evaluate(() => ({ ...(globalThis as { __e2eSecretSeen?: Record<string, boolean> }).__e2eSecretSeen }))
  }
}

test("the launch secret goes only with the app's own page", async () => {
  await withApp(async ({ app, window, sidecarUrl }) => {
    const { seen } = await recordSecret(app, sidecarUrl)
    const probe = (name: string): string => `${sidecarUrl}/health?probe=${name}`

    // The app's page itself: an image, which cannot set headers.
    await window.evaluate((src) => {
      new Image().src = src
    }, probe('app'))
    // A frame inside the app's page.
    await window.evaluate((src) => {
      const frame = document.createElement('iframe')
      frame.srcdoc = `<img src="${src}">`
      document.body.append(frame)
    }, probe('subframe'))
    await expect.poll(seen).toEqual({ app: true, subframe: false })

    // A page that isn't the app, in the app window's main frame. Only
    // main's own loadURL can put one there.
    const page = `<!doctype html><img src="${probe('page')}">`
    await (await app.browserWindow(window)).evaluate(
      (w, url) => void w.loadURL(url),
      `data:text/html,${encodeURIComponent(page)}`
    )
    await expect.poll(seen).toEqual({ app: true, subframe: false, page: false })
  })
})

test('the app window has an origin of its own', async () => {
  await withApp(async ({ window }) => {
    expect(await window.evaluate(() => location.origin)).toBe('app://workbench')
  })
})

test("the app's scheme serves the app and nothing outside it", async () => {
  await withApp(async ({ app }) => {
    // Fetched from the main process, so the page's CSP is not what
    // refuses them: only the scheme's handler is.
    const status = (url: string): Promise<number | string> =>
      app.evaluate(async ({ net }, u) => {
        try {
          return (await net.fetch(u)).status
        } catch (error) {
          return `error: ${error instanceof Error ? error.message : String(error)}`
        }
      }, url)

    expect(await status('app://workbench/index.html')).toBe(200)
    // Each of these names a file that exists next to the renderer's
    // files (the main bundle, the preload, the app's package.json).
    for (const outside of [
      'app://workbench/../main/main.js',
      'app://workbench/..%2fmain%2fmain.js',
      'app://workbench/%2e%2e%2fpreload%2fpreload.js',
      'app://workbench/..%5cmain%5cmain.js',
      'app://workbench/assets/..%2f..%2f..%2fpackage.json',
      'app://workbench/%2e%2e%5c%2e%2e%5cpackage.json',
      'app://other/index.html'
    ]) {
      expect(await status(outside), outside).toBe(404)
    }
  })
})

test('a request that outlives the closing page goes without the launch secret', async () => {
  await withApp(async ({ app, window, sidecarUrl }) => {
    // Keep the app running once its only window is gone, so the main
    // process can still be asked what it saw.
    await app.evaluate(({ app: electronApp }) => {
      electronApp.removeAllListeners('window-all-closed')
      electronApp.on('window-all-closed', () => undefined)
    })
    // Records, per request to the sidecar ("METHOD url"), whether it
    // left with the secret and how it ended: the sidecar's status, or
    // 'error' when the request was dropped on the way, as a keepalive
    // request sometimes is once its page is gone. CORS preflights,
    // which never carry the secret, are left out.
    await app.evaluate(({ session }, url) => {
      const seen: Record<string, { secret?: boolean; outcome?: number | 'error' }> = {}
      ;(globalThis as { __e2eUnload?: typeof seen }).__e2eUnload = seen
      const filter = { urls: [`${url}/*`] }
      session.defaultSession.webRequest.onSendHeaders(filter, (details) => {
        if (details.method === 'OPTIONS') return
        const key = `${details.method} ${details.url}`
        seen[key] = {
          ...seen[key],
          secret: Object.keys(details.requestHeaders).some((h) => h.toLowerCase() === 'x-workbench-secret')
        }
      })
      session.defaultSession.webRequest.onCompleted(filter, (details) => {
        if (details.method === 'OPTIONS') return
        const key = `${details.method} ${details.url}`
        seen[key] = { ...seen[key], outcome: details.statusCode }
      })
      session.defaultSession.webRequest.onErrorOccurred(filter, (details) => {
        if (details.method === 'OPTIONS') return
        const key = `${details.method} ${details.url}`
        seen[key] = { ...seen[key], outcome: 'error' }
      })
    }, sidecarUrl)

    // Keepalive requests sent from `beforeunload` outlive the page, and
    // Electron reports them without a frame, so nothing places them on
    // the app's page. The app saves before the page unloads instead
    // (unsaved-edits.spec.ts); these, a Workbench save among them,
    // must leave without the secret, so the sidecar refuses them.
    const workingUrl = `${sidecarUrl}/flist/character/123/workbench/payload`
    const otherUrl = `${sidecarUrl}/flist/character/123/snapshot`
    await window.evaluate(
      ([working, other]) => {
        addEventListener('beforeunload', () => {
          const send = (u: string, method: string): void =>
            void fetch(u, {
              method,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ character: {} }),
              keepalive: true
            }).catch(() => undefined)
          send(working, 'PUT')
          send(other, 'POST')
        })
      },
      [workingUrl, otherUrl]
    )

    // Closed the way the window's close button closes it.
    await (await app.browserWindow(window)).evaluate((w) => w.close())

    type Seen = { secret?: boolean; outcome?: number | 'error' }
    const seen = (request: string): Promise<Seen | undefined> =>
      app.evaluate(
        (_electron, key) => (globalThis as { __e2eUnload?: Record<string, Seen> }).__e2eUnload?.[key],
        request
      )
    for (const request of [`PUT ${workingUrl}`, `POST ${otherUrl}`]) {
      await expect.poll(async () => (await seen(request))?.outcome, request).toBeDefined()
      const { secret, outcome } = (await seen(request)) ?? {}
      // Unset when it was dropped before its headers went out.
      expect(secret, request).not.toBe(true)
      expect([401, 'error'], request).toContain(outcome)
    }
  })
})
