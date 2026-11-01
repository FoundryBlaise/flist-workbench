// @vitest-environment node
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import {
  createUpdates,
  updateChannel,
  updateFeedOverride,
  type Updater,
  type UpdaterStatus
} from './updates'

/** Stands in for electron-updater's autoUpdater: the outside boundary. */
class FakeUpdater implements Updater {
  private readonly events = new EventEmitter()
  autoDownload = true
  autoInstallOnAppQuit = true
  downloads = 0
  installs = 0
  checks = 0
  async checkForUpdates(): Promise<unknown> {
    this.checks += 1
    return null
  }
  async downloadUpdate(): Promise<unknown> {
    this.downloads += 1
    return []
  }
  quitAndInstall(): void {
    this.installs += 1
  }
  on(event: string, listener: (...args: never[]) => void): this {
    this.events.on(event, listener as (...args: unknown[]) => void)
    return this
  }
  /** What electron-updater does when the release feed answers. */
  emit(event: string, payload?: unknown): void {
    this.events.emit(event, payload)
  }
}

function wire(channel: 'installer' | 'portable') {
  const updater = new FakeUpdater()
  const sent: UpdaterStatus[] = []
  const updates = createUpdates(updater, { channel, onStatus: (s) => sent.push(s) })
  return { updater, sent, updates }
}

describe('updateChannel', () => {
  it('is portable when the portable launcher set its folder', () => {
    expect(updateChannel({ PORTABLE_EXECUTABLE_DIR: 'C:\\Apps' })).toBe('portable')
  })

  it('is the installer otherwise', () => {
    expect(updateChannel({})).toBe('installer')
    expect(updateChannel({ PORTABLE_EXECUTABLE_DIR: '' })).toBe('installer')
  })
})

describe('the portable build', () => {
  it('never installs on quit and never downloads on its own', () => {
    const { updater } = wire('portable')
    expect(updater.autoInstallOnAppQuit).toBe(false)
    expect(updater.autoDownload).toBe(false)
  })

  it('reports a newer release with a link to its release page', () => {
    const { updater, sent, updates } = wire('portable')
    updater.emit('update-available', { version: '0.3.0', releaseNotes: 'notes' })
    const expected = {
      kind: 'available',
      version: '0.3.0',
      releaseNotes: 'notes',
      releaseUrl: 'https://github.com/FoundryBlaise/flist-workbench/releases/tag/v0.3.0'
    }
    expect(sent.at(-1)).toEqual(expected)
    expect(updates.status()).toEqual(expected)
  })

  it('refuses to download or install even when the window asks', async () => {
    const { updater, updates } = wire('portable')
    updater.emit('update-available', { version: '0.3.0' })
    expect(await updates.download()).toBe(false)
    expect(updates.install()).toBe(false)
    expect(updater.downloads).toBe(0)
    expect(updater.installs).toBe(0)
  })

  it('still checks for a newer release', async () => {
    const { updater, updates } = wire('portable')
    expect(await updates.check()).toBe(true)
    expect(updater.checks).toBe(1)
  })
})

describe('the installer', () => {
  it('installs a downloaded update on quit', () => {
    const { updater } = wire('installer')
    expect(updater.autoInstallOnAppQuit).toBe(true)
    expect(updater.autoDownload).toBe(false)
  })

  it('offers a newer release for download, without a release link', () => {
    const { updater, sent } = wire('installer')
    updater.emit('update-available', { version: '0.3.0', releaseNotes: null })
    expect(sent.at(-1)).toEqual({ kind: 'available', version: '0.3.0', releaseNotes: null })
  })

  it('downloads and installs when the window asks', async () => {
    const { updater, updates } = wire('installer')
    expect(await updates.download()).toBe(true)
    expect(updates.install()).toBe(true)
    expect(updater.downloads).toBe(1)
    expect(updater.installs).toBe(1)
  })
})

describe('updateFeedOverride', () => {
  const feed = { FLIST_WORKBENCH_UPDATE_FEED: 'http://127.0.0.1:50123/' }

  it('points an unpackaged build at a fake release on this machine', () => {
    expect(updateFeedOverride(false, feed)).toBe('http://127.0.0.1:50123/')
  })

  it('is never honored by a packaged build', () => {
    expect(updateFeedOverride(true, feed)).toBeNull()
  })

  it('only points at this machine', () => {
    expect(updateFeedOverride(false, { FLIST_WORKBENCH_UPDATE_FEED: 'https://example.com/' })).toBeNull()
    expect(updateFeedOverride(false, { FLIST_WORKBENCH_UPDATE_FEED: 'not a url' })).toBeNull()
    expect(updateFeedOverride(false, {})).toBeNull()
  })
})
