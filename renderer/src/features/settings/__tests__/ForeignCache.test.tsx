// Settings → Foreign profiles shows how much disk the Foreign profile
// cache takes, lets the user set its cap, and clears it by hand.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { api } from '../../../lib/api'
import { SettingsModal } from '../SettingsModal'

const MB = 1024 * 1024

const SETTINGS = {
  fchat_data_dir: null,
  fchat_data_dir_effective: 'C:/fchat/data',
  fchat_data_dir_env_locked: false,
  labels: { threshold_chars: 200, defaults: { threshold_chars: 200 } },
  rag: {},
  image_import_roots: [],
  mcp: { log_text: false },
  foreign: { cache_cap_mb: 1024, defaults: { cache_cap_mb: 1024 } }
}

beforeEach(() => {
  vi.spyOn(api, 'settingsGet').mockResolvedValue(SETTINGS as never)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const used = () => screen.getByTestId('settings-foreign-cache-used').textContent
const capInput = () => screen.getByTestId('settings-foreign-cache-cap') as HTMLInputElement

function openForeign() {
  render(<SettingsModal onClose={() => {}} initialSection="foreign" />)
}

it('shows the space the cache uses and its cap', async () => {
  vi.spyOn(api, 'foreignCacheUsage').mockResolvedValue({
    bytes: 5 * MB,
    profiles: 3,
    cap_bytes: 1024 * MB
  })
  openForeign()

  await waitFor(() => expect(used()).toBe('5.0 MB in 3 profiles'))
  expect(capInput().value).toBe('1024')
})

it('a small cache is shown in KB, a single profile as one', async () => {
  vi.spyOn(api, 'foreignCacheUsage').mockResolvedValue({
    bytes: 20_000,
    profiles: 1,
    cap_bytes: 1024 * MB
  })
  openForeign()

  await waitFor(() => expect(used()).toBe('20 KB in 1 profile'))
})

it('setting a lower cap saves it and shows what is left after eviction', async () => {
  vi.spyOn(api, 'foreignCacheUsage')
    .mockResolvedValueOnce({ bytes: 300 * MB, profiles: 9, cap_bytes: 1024 * MB })
    .mockResolvedValue({ bytes: 90 * MB, profiles: 2, cap_bytes: 100 * MB })
  const update = vi.spyOn(api, 'settingsUpdate').mockResolvedValue({
    ...SETTINGS,
    foreign: { cache_cap_mb: 100, defaults: { cache_cap_mb: 1024 } }
  } as never)
  openForeign()
  await waitFor(() => expect(used()).toBe('300.0 MB in 9 profiles'))

  fireEvent.change(capInput(), { target: { value: '100' } })
  fireEvent.click(screen.getByTestId('settings-foreign-cache-cap-set'))

  await waitFor(() => expect(used()).toBe('90.0 MB in 2 profiles'))
  expect(update).toHaveBeenCalledTimes(1)
  expect(update).toHaveBeenCalledWith({ foreign: { cache_cap_mb: 100 } })
  expect(capInput().value).toBe('100')
})

it('refuses a cap under one megabyte without saving', async () => {
  vi.spyOn(api, 'foreignCacheUsage').mockResolvedValue({
    bytes: 0,
    profiles: 0,
    cap_bytes: 1024 * MB
  })
  const update = vi.spyOn(api, 'settingsUpdate')
  openForeign()
  await waitFor(() => expect(capInput().value).toBe('1024'))

  fireEvent.change(capInput(), { target: { value: '0' } })
  fireEvent.click(screen.getByTestId('settings-foreign-cache-cap-set'))

  expect(await screen.findByText('The cap must be a whole number of at least 1 MB.')).toBeTruthy()
  expect(update).not.toHaveBeenCalled()
})

it('clearing by hand empties the cache and the space drops to zero', async () => {
  vi.spyOn(api, 'foreignCacheUsage').mockResolvedValue({
    bytes: 42 * MB,
    profiles: 4,
    cap_bytes: 1024 * MB
  })
  const clear = vi.spyOn(api, 'foreignCacheClear').mockResolvedValue({
    removed: 4,
    bytes: 0,
    profiles: 0,
    cap_bytes: 1024 * MB
  })
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  openForeign()
  await waitFor(() => expect(used()).toBe('42.0 MB in 4 profiles'))

  fireEvent.click(screen.getByTestId('settings-foreign-cache-clear'))

  await waitFor(() => expect(used()).toBe('0 B in 0 profiles'))
  expect(clear).toHaveBeenCalledTimes(1)
})
