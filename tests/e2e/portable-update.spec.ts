import { test, expect } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { menuAction, withApp } from './launch'

// The portable build never downloads or installs an update (ADR 0005).
// The app runs as the portable build (PORTABLE_EXECUTABLE_DIR, as the
// portable launcher sets it) against a fake newer release served here
// on localhost; the real GitHub releases are never asked.

const NEWER = '99.0.0'
const SETUP = `F-list-Workbench-${NEWER}-x64.exe`

const LATEST_YML = `version: ${NEWER}
files:
  - url: ${SETUP}
    sha512: ${'A'.repeat(86)}==
    size: 1024
path: ${SETUP}
sha512: ${'A'.repeat(86)}==
releaseDate: '2026-11-01T00:00:00.000Z'
`

/** A release feed that answers latest.yml and writes down every path asked for. */
async function fakeReleaseFeed(): Promise<{ url: string; asked: string[]; server: Server }> {
  const asked: string[] = []
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    asked.push(path)
    if (path === '/latest.yml') {
      res.writeHead(200, { 'Content-Type': 'text/yaml' })
      res.end(LATEST_YML)
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  if (!address || typeof address !== 'object') throw new Error('fake release feed has no port')
  return { url: `http://127.0.0.1:${address.port}/`, asked, server }
}

test('the portable build links to a newer release and downloads nothing', async () => {
  const feed = await fakeReleaseFeed()
  const root = process.env['FLIST_WB_E2E_ROOT'] ?? ''
  const portableDir = await mkdtemp(join(root, 'portable-'))
  // Where electron-updater would cache a download, kept out of the
  // user's own %LOCALAPPDATA% should one ever start.
  const localAppData = await mkdtemp(join(root, 'localappdata-'))
  try {
    await withApp(
      async ({ app, window }) => {
        // Help → Check for Updates, as the user would.
        await menuAction(app, 'check-updates')

        const card = window.locator('.updater-toast')
        await expect(card).toContainText('New version available')
        await expect(card.getByRole('link', { name: `Get ${NEWER}` })).toHaveAttribute(
          'href',
          `https://github.com/FoundryBlaise/flist-workbench/releases/tag/v${NEWER}`
        )
        await expect(card.getByRole('button', { name: 'Update' })).toHaveCount(0)

        // Even asked directly over the bridge, main starts no download.
        type Bridge = { workbench: { updater: { download(): Promise<boolean> } } }
        const started = await window.evaluate(() =>
          (globalThis as unknown as Bridge).workbench.updater.download()
        )
        expect(started).toBe(false)
        expect(feed.asked.filter((p) => p !== '/latest.yml')).toEqual([])
        expect(feed.asked).toContain('/latest.yml')
      },
      {
        env: {
          PORTABLE_EXECUTABLE_DIR: portableDir,
          FLIST_WORKBENCH_UPDATE_FEED: feed.url,
          LOCALAPPDATA: localAppData
        }
      }
    )
  } finally {
    await new Promise((resolveClose) => feed.server.close(resolveClose))
  }
})
