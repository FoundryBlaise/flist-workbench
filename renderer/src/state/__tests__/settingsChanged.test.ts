// A settings change made elsewhere (a model over MCP) reaches the
// window as `settings-changed`. The OOC threshold is applied when a Log
// is read, so a new one has to re-read the open Log for its Labels.

import { afterEach, beforeEach, expect, it } from 'vitest'
import { useStore } from '../../state'
import { installFakeApi, json, type FakeApi } from '../../test/fakeApi'

let fake: FakeApi

beforeEach(() => {
  fake = installFakeApi()
  useStore.setState({
    activeCharacter: 'Corin Vale',
    activePartner: 'Daelan Envale',
    messagesByPartner: {},
    messagesStatus: {},
    messagesError: {}
  })
})

afterEach(() => {
  fake.restore()
})

it('re-reads the open Log when the OOC threshold changed', async () => {
  fake.on('GET /logs/messages', json({ messages: [] }))
  await useStore.getState().loadMessages('Corin Vale', 'Daelan Envale')
  expect(fake.requestsTo('GET /logs/messages')).toHaveLength(1)

  useStore.getState().noteSettingsChanged(['labels.threshold_chars'])

  await expect.poll(() => fake.requestsTo('GET /logs/messages').length).toBe(2)
})

it('leaves the open Log alone when only search settings changed', async () => {
  fake.on('GET /logs/messages', json({ messages: [] }))
  await useStore.getState().loadMessages('Corin Vale', 'Daelan Envale')

  useStore.getState().noteSettingsChanged(['rag.top_k'])
  await new Promise((resolve) => setTimeout(resolve, 20))

  expect(fake.requestsTo('GET /logs/messages')).toHaveLength(1)
})
