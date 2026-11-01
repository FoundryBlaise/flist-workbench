// The update card. The installer offers to download a newer release;
// the portable build never downloads (ADR 0005), so its card says a new
// version exists and links to the release instead.

import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { UpdateAvailableModal } from '../UpdateAvailableModal'

const RELEASE = 'https://github.com/FoundryBlaise/flist-workbench/releases/tag/v0.3.0'

afterEach(() => {
  cleanup()
})

it('on the portable build, links to the release and offers no download', () => {
  render(
    <UpdateAvailableModal
      status={{ kind: 'available', version: '0.3.0', releaseUrl: RELEASE }}
      onDismiss={vi.fn()}
    />
  )
  expect(screen.getByRole('status').textContent).toMatch(/new version available/i)
  expect(screen.getByRole('link', { name: /0\.3\.0/ }).getAttribute('href')).toBe(RELEASE)
  expect(screen.queryByRole('button', { name: 'Update' })).toBeNull()
})

it('on the installer, offers the download as before', () => {
  render(<UpdateAvailableModal status={{ kind: 'available', version: '0.3.0' }} onDismiss={vi.fn()} />)
  expect(screen.getByRole('button', { name: 'Update' })).toBeTruthy()
  expect(screen.queryByRole('link')).toBeNull()
})
