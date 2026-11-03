// Settings → MCP holds the switch for the tools that return Log text.
// It is off by default, says plainly that a cloud model's provider
// receives that text, and one click turns it on.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { api, type McpInfo } from '../../../lib/api'
import { SettingsModal } from '../SettingsModal'

const SETTINGS = {
  fchat_data_dir: null,
  fchat_data_dir_effective: 'C:/fchat/data',
  fchat_data_dir_env_locked: false,
  labels: { threshold_chars: 200 },
  rag: {
    embed_model: 'm',
    top_k: 8,
    rerank_candidates: 40,
    neighbors: 1,
    rerank_model: 'disabled',
    rerank_min_ratio: 0,
    hybrid_enabled: false,
    hybrid_bm25_candidates: 40,
    chunk_max_chars: 2000,
    chunk_soft_split_chars: 1500,
    chunk_overlap_msgs: 1
  },
  image_import_roots: [],
  mcp: { log_text: false }
}

function info(logsTools: number): McpInfo {
  return {
    port: 27384,
    endpoints: [
      {
        id: 'logs',
        label: 'Logs, labels and retrieval only',
        path: '/mcp/logs',
        url: 'http://127.0.0.1:27384/mcp/logs',
        tool_count: logsTools
      }
    ],
    auth: { required: false, token: null }
  }
}

beforeEach(() => {
  vi.spyOn(api, 'settingsGet').mockResolvedValue(SETTINGS as never)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function openMcp() {
  render(<SettingsModal onClose={() => {}} initialSection="mcp" />)
}

it('shows the switch off by default, with the note about cloud providers', async () => {
  vi.spyOn(api, 'mcpInfo').mockResolvedValue(info(24))
  openMcp()

  const toggle = await screen.findByTestId('settings-mcp-log-text-toggle')
  await waitFor(() => expect(toggle.textContent).toBe('Turn on'))
  expect(screen.getByTestId('settings-mcp-log-text-state').textContent).toBe('Off')
  expect(screen.getByText(/its provider receives that text/)).toBeTruthy()
})

it('one click turns it on, and the tool counts follow', async () => {
  vi.spyOn(api, 'mcpInfo')
    .mockResolvedValueOnce(info(24))
    .mockResolvedValue(info(28))
  const update = vi
    .spyOn(api, 'settingsUpdate')
    .mockResolvedValue({ ...SETTINGS, mcp: { log_text: true } } as never)
  openMcp()

  const toggle = await screen.findByTestId('settings-mcp-log-text-toggle')
  await waitFor(() => expect(toggle.textContent).toBe('Turn on'))
  fireEvent.click(toggle)

  await waitFor(() =>
    expect(screen.getByTestId('settings-mcp-log-text-state').textContent).toBe('On')
  )
  expect(update).toHaveBeenCalledTimes(1)
  expect(update).toHaveBeenCalledWith({ mcp: { log_text: true } })
  expect(toggle.textContent).toBe('Turn off')
  expect(await screen.findByText(/^28 tools\./)).toBeTruthy()
})

it('turning it off again sends false', async () => {
  vi.spyOn(api, 'settingsGet').mockResolvedValue({
    ...SETTINGS,
    mcp: { log_text: true }
  } as never)
  vi.spyOn(api, 'mcpInfo').mockResolvedValue(info(28))
  const update = vi
    .spyOn(api, 'settingsUpdate')
    .mockResolvedValue({ ...SETTINGS, mcp: { log_text: false } } as never)
  openMcp()

  const toggle = await screen.findByTestId('settings-mcp-log-text-toggle')
  await waitFor(() => expect(toggle.textContent).toBe('Turn off'))
  fireEvent.click(toggle)

  await waitFor(() =>
    expect(screen.getByTestId('settings-mcp-log-text-state').textContent).toBe('Off')
  )
  expect(update).toHaveBeenCalledWith({ mcp: { log_text: false } })
})
