// The question the window asks when a model and the user changed the
// same fields of a Workbench: exactly those fields, by the names
// the user knows them by, "Keep mine" / "Take theirs" each, and the
// merge applied once all are answered. Driven from a real model event
// through the store against the fake sidecar.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useStore } from '../../state'
import { resetUndoStacks } from '../../state/undoStack'
import { applyWorkbenchEvent } from '../../state/workbenchEvents'
import { installFakeApi, json, type FakeApi } from '../../test/fakeApi'
import { payloadRead, workbenchPayload, workingSlot } from '../../test/payloads'
import { MergeDialog } from '../MergeDialog'

const CID = '99'
const BENCH = `/flist/character/${CID}/workbench/payload`

const SAVED = workbenchPayload({
  character: { description: 'as I left her', custom_title: 'the wanderer' },
  infotags: { '3': '1' },
  kinks: { '10': 'yes' }
})

let fake: FakeApi

const rows = () => screen.queryAllByTestId('merge-field')
const store = () => useStore.getState()
const slotPayload = () =>
  store().flistWorking[CID].payload as {
    character: { description: string; custom_title: string }
    infotags: Record<string, string>
    kinks: Record<string, string>
  }

/** I change the description, the species and a kink; the model changes
 *  the description, the species and the custom title. */
async function bothChangedTwoFields() {
  store().setEditorContent('my version of her')
  store().flistSetWorkingField(CID, 'infotags.3', '2')
  store().flistSetWorkingField(CID, 'kinks.10', 'fave')
  const theirs = JSON.parse(JSON.stringify(SAVED))
  theirs.character.description = 'their version of her'
  theirs.character.custom_title = 'the found'
  theirs.infotags['3'] = '3'
  fake.on(`GET ${BENCH}`, json(payloadRead(theirs, 'theirs')))
  await act(async () => {
    applyWorkbenchEvent(
      { event: 'set-payload-changed', at: 1, origin: 'mcp:set_description', character_id: CID, etag: 'theirs' },
      store()
    )
    await vi.advanceTimersByTimeAsync(0)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  fake = installFakeApi()
  resetUndoStacks()
  useStore.setState({
    flistWorking: { [CID]: workingSlot(SAVED) },
    flistExternalChange: {},
    flistMergeQuestion: {},
    flistViewingLive: {},
    flistBrowseBackup: null,
    flistActiveCharacterId: CID,
    editorReadOnly: false,
    editorContent: 'as I left her',
    flistMapping: {
      status: 'ready',
      payload: {
        _etag: null,
        _fetched_at: null,
        infotags: [{ id: 3, name: 'Species', type: 'list', list: 'species' }],
        listitems: [
          { id: 1, name: 'species', value: 'Elf' },
          { id: 2, name: 'species', value: 'Half-elf' },
          { id: 3, name: 'species', value: 'Drow' }
        ],
        kinks: [{ id: 10, name: 'Stargazing' }]
      },
      fetchedAt: null,
      etag: null,
      error: null
    }
  })
})

afterEach(() => {
  cleanup()
  fake.restore()
  vi.useRealTimers()
})

it('shows nothing while there is no question', () => {
  render(<MergeDialog />)
  expect(screen.queryByTestId('merge-dialog')).toBeNull()
})

it('lists exactly the fields both changed, by name, with both versions', async () => {
  render(<MergeDialog />)
  await bothChangedTwoFields()

  expect(screen.getByTestId('merge-dialog').textContent).toContain('a connected model — set_description')
  expect(rows().map((r) => r.querySelector('.merge-field-name')?.textContent)).toEqual([
    'Description',
    'Species'
  ])
  const species = within(rows()[1])
  expect(species.getByTestId('merge-keep-mine').parentElement?.textContent).toContain('Half-elf')
  expect(species.getByTestId('merge-take-theirs').parentElement?.textContent).toContain('Drow')
  const description = within(rows()[0])
  expect(description.getByTestId('merge-keep-mine').parentElement?.textContent).toContain('my version of her')
  expect(description.getByTestId('merge-take-theirs').parentElement?.textContent).toContain('their version of her')
})

it('applies the merge once every field is answered, and saves it over their etag', async () => {
  fake.on(`PUT ${BENCH}`, json({ etag: 'merged' }))
  render(<MergeDialog />)
  await bothChangedTwoFields()

  fireEvent.click(within(rows()[0]).getByTestId('merge-take-theirs'))
  expect(screen.getByTestId('merge-apply')).toHaveProperty('disabled', true)
  fireEvent.click(within(rows()[1]).getByTestId('merge-keep-mine'))
  fireEvent.click(screen.getByTestId('merge-apply'))

  expect(screen.queryByTestId('merge-dialog')).toBeNull()
  expect(slotPayload().character).toEqual({ description: 'their version of her', custom_title: 'the found' })
  expect(slotPayload().infotags['3']).toBe('2')
  expect(slotPayload().kinks['10']).toBe('fave')
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500)
  })
  const [save] = fake.requestsTo(`PUT ${BENCH}`)
  expect(save.headers['If-Match']).toBe('theirs')
})
