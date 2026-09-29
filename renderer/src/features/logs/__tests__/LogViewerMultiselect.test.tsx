// Multiselect in the log view: tick messages anywhere in a conversation,
// by click or by shift-click range, and give them all one label in one
// go, from the bar or from a right-click on any ticked row.

import type { ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useStore } from '../../../state'
import { api, type LogMessage } from '../../../lib/api'
import { LogViewer } from '../LogViewer'

// jsdom has no layout, so the real Virtuoso renders no rows at all.
vi.mock('react-virtuoso', () => ({
  Virtuoso: ({
    data,
    itemContent,
    computeItemKey
  }: {
    data: unknown[]
    itemContent: (i: number, d: unknown) => ReactNode
    computeItemKey: (i: number, d: unknown) => string
  }) => (
    <div>
      {data.map((d, i) => (
        <div key={computeItemKey(i, d)}>{itemContent(i, d)}</div>
      ))}
    </div>
  )
}))

const CHAR = 'Amber'
const PARTNER = 'Bram'

function msg(n: number, over: Partial<LogMessage> = {}): LogMessage {
  const text = `line ${n}`
  return {
    ts: 1_700_000_000 + n,
    iso: '',
    type: 0,
    type_name: 'chat',
    speaker: n % 2 ? PARTNER : CHAR,
    raw: text,
    text,
    mentions: [],
    kind: 'ic',
    hash: `h${n}`,
    label: 'Unlabeled',
    ...over
  }
}

function seed(messages: LogMessage[]) {
  useStore.setState({
    activeCharacter: CHAR,
    activePartner: PARTNER,
    messagesByPartner: { [`${CHAR}::${PARTNER}`]: messages },
    messagesStatus: { [`${CHAR}::${PARTNER}`]: 'ready' },
    messagesError: {},
    loadMessages: vi.fn(async () => {}),
    markCharacterSeen: vi.fn()
  } as never)
}

/** The row element holding `line n`. */
function row(n: number): HTMLElement {
  const el = screen.getByText(`line ${n}`).closest('.log-msg')
  if (!el) throw new Error(`no row for line ${n}`)
  return el as HTMLElement
}

function labelOf(n: number): string | undefined {
  return useStore
    .getState()
    .messagesByPartner[`${CHAR}::${PARTNER}`].find((m) => m.hash === `h${n}`)?.label
}

let overrideMany: MockInstance<typeof api.labelsOverrideMany>
let overrideOne: MockInstance<typeof api.labelsOverride>

beforeEach(() => {
  overrideMany = vi
    .spyOn(api, 'labelsOverrideMany')
    .mockImplementation(async (body) => ({
      character: body.character,
      partner: body.partner,
      label: body.label,
      changed: body.items.length
    }))
  overrideOne = vi.spyOn(api, 'labelsOverride').mockImplementation(async (body) => ({
    hash: body.hash,
    label: body.label
  }))
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('labels rows that are not next to each other, in one request', async () => {
  seed([1, 2, 3, 4, 5].map((n) => msg(n)))
  render(<LogViewer />)

  fireEvent.click(screen.getByTestId('log-export-toggle'))
  fireEvent.click(row(1))
  fireEvent.click(row(3))
  fireEvent.click(row(5))
  expect(screen.getByTestId('log-export-status').textContent).toContain('3 selected')
  expect((within(row(2)).getByTestId('log-msg-check') as HTMLInputElement).checked).toBe(false)

  fireEvent.click(screen.getByTestId('log-export-set-ooc'))

  await waitFor(() => expect(overrideMany).toHaveBeenCalledTimes(1))
  const body = overrideMany.mock.calls[0][0]
  expect(body.label).toBe('OOC')
  expect(body.items.map((i) => i.hash)).toEqual(['h1', 'h3', 'h5'])
  expect([1, 2, 3, 4, 5].map(labelOf)).toEqual(['OOC', 'Unlabeled', 'OOC', 'Unlabeled', 'OOC'])
  expect(overrideOne).not.toHaveBeenCalled()
})

it('shift-click adds the range and a second click unticks a row', () => {
  seed([1, 2, 3, 4, 5].map((n) => msg(n)))
  render(<LogViewer />)

  fireEvent.click(screen.getByTestId('log-export-toggle'))
  fireEvent.click(row(2))
  fireEvent.click(row(4), { shiftKey: true })
  expect(screen.getByTestId('log-export-status').textContent).toContain('3 selected')

  fireEvent.click(row(3))
  expect(screen.getByTestId('log-export-status').textContent).toContain('2 selected')
  expect((within(row(3)).getByTestId('log-msg-check') as HTMLInputElement).checked).toBe(false)
})

it('a shift-click range skips the rows a filter hides', () => {
  seed([
    msg(1, { label: 'IC', label_source: 'mcp' }),
    msg(2, { label: 'OOC', label_source: 'mcp' }),
    msg(3, { label: 'IC', label_source: 'mcp' })
  ])
  render(<LogViewer />)

  fireEvent.click(screen.getByRole('button', { name: /^OOC/ }))
  fireEvent.click(screen.getByTestId('log-export-toggle'))
  fireEvent.click(row(1))
  fireEvent.click(row(3), { shiftKey: true })
  expect(screen.getByTestId('log-export-status').textContent).toContain('2 selected')
})

it('right-click on a ticked row labels the whole selection', async () => {
  seed([1, 2, 3, 4].map((n) => msg(n)))
  render(<LogViewer />)

  fireEvent.click(screen.getByTestId('log-export-toggle'))
  fireEvent.click(row(1))
  fireEvent.click(row(4))
  fireEvent.contextMenu(row(4))

  expect(screen.getByTestId('log-label-menu-head').textContent).toContain('Label 2 messages')
  fireEvent.click(screen.getByTestId('log-label-menu-ic'))

  await waitFor(() => expect(overrideMany).toHaveBeenCalledTimes(1))
  expect(overrideMany.mock.calls[0][0].items.map((i) => i.hash)).toEqual([
    'h1',
    'h4'
  ])
  expect(overrideOne).not.toHaveBeenCalled()
})

it('right-click on an unticked row labels just that row', async () => {
  seed([1, 2, 3].map((n) => msg(n)))
  render(<LogViewer />)

  fireEvent.click(screen.getByTestId('log-export-toggle'))
  fireEvent.click(row(1))
  fireEvent.click(row(2))
  fireEvent.contextMenu(row(3))

  expect(screen.getByTestId('log-label-menu-head').textContent).toContain('Label this message')
  fireEvent.click(screen.getByTestId('log-label-menu-ic'))

  await waitFor(() => expect(overrideOne).toHaveBeenCalledTimes(1))
  expect(overrideOne.mock.calls[0][0].hash).toBe('h3')
  expect(overrideMany).not.toHaveBeenCalled()
})

it('undo puts back each row’s own earlier verdict', async () => {
  seed([
    msg(1, { label: 'IC', label_source: 'mcp' }),
    // Rule-decided OOC: no stored verdict, so undo resets it.
    msg(2, { label: 'OOC' }),
    msg(3)
  ])
  render(<LogViewer />)

  fireEvent.click(screen.getByTestId('log-export-toggle'))
  fireEvent.click(row(1))
  fireEvent.click(row(3), { shiftKey: true })
  fireEvent.click(screen.getByTestId('log-export-set-ooc'))
  await waitFor(() => expect(screen.queryByTestId('log-undo-toast')).not.toBeNull())
  expect(screen.getByTestId('log-export-status').textContent).toContain('Click to tick')

  fireEvent.click(screen.getByTestId('log-undo-action'))
  await waitFor(() => expect(overrideMany).toHaveBeenCalledTimes(3))
  const undoCalls = overrideMany.mock.calls
    .slice(1)
    .map(([b]) => [
      b.label,
      b.items.map((i) => i.hash)
    ])
  expect(undoCalls).toEqual(
    expect.arrayContaining([
      ['IC', ['h1']],
      [null, ['h2', 'h3']]
    ])
  )
})
