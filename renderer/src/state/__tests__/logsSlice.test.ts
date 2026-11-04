// The Logs slice: the characters with Logs, their conversation
// partners, the messages of the open Log and their Labels, the ingest
// dialog, the Index and Labels revisions, and cross search. Seam: the
// one store, against the fake sidecar.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useStore } from '../../state'
import { logsInitialState } from '../slices/logs'
import { installFakeApi, json, type FakeApi } from '../../test/fakeApi'
import type { LogMessage } from '../../lib/api'

let fake: FakeApi

beforeEach(() => {
  fake = installFakeApi()
  useStore.setState(logsInitialState())
})

afterEach(() => {
  fake.restore()
})

function message(hash: string, extra: Partial<LogMessage> = {}): LogMessage {
  return {
    ts: 1700000000,
    iso: '2023-11-14T22:13:20Z',
    type: 0,
    type_name: 'chat',
    speaker: 'Corin Vale',
    raw: `line ${hash}`,
    text: `line ${hash}`,
    mentions: [],
    kind: 'ic',
    hash,
    ...extra
  } as LogMessage
}

describe('the Logs slice as the window starts', () => {
  it('holds no Logs, no open conversation and no dialog', () => {
    const s = useStore.getState()
    expect(s.characters).toEqual([])
    expect(s.charactersStatus).toBe('idle')
    expect(s.charactersError).toBeNull()
    expect(s.activeCharacter).toBeNull()
    expect(s.activePartner).toBeNull()
    expect(s.crossSearchOpen).toBe(false)
    expect(s.partners).toEqual({})
    expect(s.messagesByPartner).toEqual({})
    expect(s.ingestTarget).toBeNull()
    expect(s.indexRevision).toBe(0)
    expect(s.labelsRevision).toBe(0)
  })

  it('gives every reset its own maps', () => {
    const first = logsInitialState()
    first.partners.Quill = []
    expect(logsInitialState().partners).toEqual({})
  })
})

describe('characters with Logs', () => {
  it('reads them and opens the first when none is open', async () => {
    fake.on(
      'GET /logs/characters',
      json({ characters: [{ name: 'Corin Vale', mtime: 2 }, { name: 'Quill', mtime: 1 }] })
    )

    await useStore.getState().loadCharacters()

    const s = useStore.getState()
    expect(s.charactersStatus).toBe('ready')
    expect(s.characters.map((c) => c.name)).toEqual(['Corin Vale', 'Quill'])
    expect(s.activeCharacter).toBe('Corin Vale')
  })

  it('keeps the character already open', async () => {
    useStore.setState({ activeCharacter: 'Quill' })
    fake.on('GET /logs/characters', json({ characters: [{ name: 'Corin Vale', mtime: 2 }] }))

    await useStore.getState().loadCharacters()

    expect(useStore.getState().activeCharacter).toBe('Quill')
  })

  it('says why when the sidecar cannot list them', async () => {
    fake.on('GET /logs/characters', json({ code: 'logs_unreadable', message: 'logs folder missing' }, 500))

    await useStore.getState().loadCharacters()

    const s = useStore.getState()
    expect(s.charactersStatus).toBe('error')
    expect(s.charactersError).toContain('logs folder missing')
  })
})

describe('conversation partners', () => {
  it('reads one character’s partners', async () => {
    fake.on(
      'GET /logs/partners',
      json({ character: 'Corin Vale', partners: [{ name: 'Daelan Envale', bytes: 10, aliases: [] }] })
    )

    await useStore.getState().loadPartners('Corin Vale')

    const s = useStore.getState()
    expect(s.partnersStatus['Corin Vale']).toBe('ready')
    expect(s.partners['Corin Vale'].map((p) => p.name)).toEqual(['Daelan Envale'])
    expect(fake.requestsTo('GET /logs/partners')[0].path).toBe('/logs/partners?char=Corin%20Vale')
  })

  it('marks the list failed when the read fails', async () => {
    fake.on('GET /logs/partners', json({ code: 'logs_unreadable', message: 'nope' }, 500))

    await useStore.getState().loadPartners('Corin Vale')

    expect(useStore.getState().partnersStatus['Corin Vale']).toBe('error')
  })

  it('opening a conversation closes cross search', () => {
    useStore.getState().setCrossSearchOpen(true)
    expect(useStore.getState().crossSearchOpen).toBe(true)

    useStore.getState().selectPartner('Daelan Envale')

    const s = useStore.getState()
    expect(s.activePartner).toBe('Daelan Envale')
    expect(s.crossSearchOpen).toBe(false)
  })
})

describe('messages of a Log', () => {
  it('reads a conversation once and answers from the cache after', async () => {
    fake.on('GET /logs/messages', json({ messages: [message('a1')] }))

    await useStore.getState().loadMessages('Corin Vale', 'Daelan Envale')
    await useStore.getState().loadMessages('Corin Vale', 'Daelan Envale')

    const s = useStore.getState()
    expect(fake.requestsTo('GET /logs/messages')).toHaveLength(1)
    expect(fake.requestsTo('GET /logs/messages')[0].path).toBe(
      '/logs/messages?char=Corin%20Vale&partner=Daelan%20Envale'
    )
    expect(s.messagesStatus['Corin Vale::Daelan Envale']).toBe('ready')
    expect(s.messagesByPartner['Corin Vale::Daelan Envale'].map((m) => m.hash)).toEqual(['a1'])
  })

  it('reads again when forced or after the cache was dropped', async () => {
    fake.on('GET /logs/messages', json({ messages: [message('a1')] }))
    await useStore.getState().loadMessages('Corin Vale', 'Daelan Envale')

    await useStore.getState().loadMessages('Corin Vale', 'Daelan Envale', { force: true })
    expect(fake.requestsTo('GET /logs/messages')).toHaveLength(2)

    useStore.getState().invalidateMessages('Corin Vale', 'Daelan Envale')
    expect(useStore.getState().messagesByPartner['Corin Vale::Daelan Envale']).toBeUndefined()
    await useStore.getState().loadMessages('Corin Vale', 'Daelan Envale')
    expect(fake.requestsTo('GET /logs/messages')).toHaveLength(3)
  })

  it('keeps conversations of two partners apart', async () => {
    fake.on('GET /logs/messages?char=Corin%20Vale&partner=Daelan%20Envale', json({ messages: [message('d1')] }))
    fake.on('GET /logs/messages?char=Corin%20Vale&partner=Quill', json({ messages: [message('q1')] }))

    await useStore.getState().loadMessages('Corin Vale', 'Daelan Envale')
    await useStore.getState().loadMessages('Corin Vale', 'Quill')
    useStore.getState().invalidateMessages('Corin Vale', 'Quill')

    const s = useStore.getState()
    expect(s.messagesByPartner['Corin Vale::Daelan Envale'].map((m) => m.hash)).toEqual(['d1'])
    expect(s.messagesByPartner['Corin Vale::Quill']).toBeUndefined()
  })

  it('says why a read failed', async () => {
    fake.on('GET /logs/messages', json({ code: 'logs_unreadable', message: 'Log unreadable' }, 500))

    await useStore.getState().loadMessages('Corin Vale', 'Daelan Envale')

    const s = useStore.getState()
    expect(s.messagesStatus['Corin Vale::Daelan Envale']).toBe('error')
    expect(s.messagesError['Corin Vale::Daelan Envale']).toContain('Log unreadable')
  })
})

describe('Labels on the open Log', () => {
  beforeEach(async () => {
    fake.on(
      'GET /logs/messages',
      json({
        messages: [
          message('a1', { label: 'IC', label_source: 'llm' } as Partial<LogMessage>),
          message('a2'),
          message('a3')
        ]
      })
    )
    await useStore.getState().loadMessages('Corin Vale', 'Daelan Envale')
  })

  function labels(): Array<[unknown, unknown]> {
    return useStore
      .getState()
      .messagesByPartner['Corin Vale::Daelan Envale'].map((m) => [m.label, m.label_source])
  }

  it('sets one message’s Label by hash', () => {
    useStore.getState().applyLabelOverride('Corin Vale', 'Daelan Envale', 'a2', {
      label: 'OOC',
      label_source: 'manual'
    })

    expect(labels()).toEqual([
      ['IC', 'llm'],
      ['OOC', 'manual'],
      [undefined, undefined]
    ])
  })

  it('sets the Label of every message in a selection in one go', () => {
    useStore.getState().applyLabelOverride('Corin Vale', 'Daelan Envale', new Set(['a1', 'a3']), {
      label: 'OOC',
      label_source: 'manual'
    })

    expect(labels()).toEqual([
      ['OOC', 'manual'],
      [undefined, undefined],
      ['OOC', 'manual']
    ])
  })

  it('clears a Label so the next read resolves it again', () => {
    useStore.getState().applyLabelOverride('Corin Vale', 'Daelan Envale', 'a1', null)

    expect(labels()[0]).toEqual([undefined, undefined])
    expect(fake.requests).toHaveLength(1)
  })

  it('leaves a conversation not read yet alone', () => {
    useStore.getState().applyLabelOverride('Corin Vale', 'Quill', 'a1', { label: 'OOC' })

    expect(useStore.getState().messagesByPartner['Corin Vale::Quill']).toBeUndefined()
  })
})

describe('the ingest dialog and what changed elsewhere', () => {
  it('opens the ingest dialog for a scope and closes it', () => {
    useStore.getState().openIngest({ character: 'Corin Vale' }, 'Corin Vale')
    expect(useStore.getState().ingestTarget).toEqual({
      scope: { character: 'Corin Vale' },
      label: 'Corin Vale',
      forceRewipe: false
    })

    useStore.getState().openIngest({}, 'All', { forceRewipe: true })
    expect(useStore.getState().ingestTarget?.forceRewipe).toBe(true)

    useStore.getState().closeIngest()
    expect(useStore.getState().ingestTarget).toBeNull()
  })

  it('moves the Index and Labels revisions so views re-read', () => {
    useStore.getState().noteIndexChanged()
    useStore.getState().noteIndexChanged()
    useStore.getState().noteLabelsChanged()

    const s = useStore.getState()
    expect(s.indexRevision).toBe(2)
    expect(s.labelsRevision).toBe(1)
    expect(fake.requests).toHaveLength(0)
  })
})
