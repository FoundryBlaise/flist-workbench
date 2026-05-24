import { describe, it, expect } from 'vitest'
import { exportMessages } from './sceneExport'
import type { LogMessage } from './api'

function msg(ts: number, speaker: string, text: string, kind: LogMessage['kind'] = 'ic'): LogMessage {
  return {
    ts,
    iso: new Date(ts * 1000).toISOString(),
    type: kind === 'ic' ? 1 : 0,
    type_name: 'chat',
    speaker,
    raw: text,
    text,
    mentions: [],
    kind
  }
}

describe('exportMessages markdown', () => {
  it('returns an empty string when given no messages', () => {
    expect(exportMessages([], 'partner', 'me', 'markdown')).toBe('')
  })

  it('produces a markdown scene with day separators and speaker tags', () => {
    const day1 = Math.floor(new Date('2026-05-01T10:30:00Z').getTime() / 1000)
    const day2 = Math.floor(new Date('2026-05-02T08:15:00Z').getTime() / 1000)
    const out = exportMessages(
      [msg(day1, 'Aina', 'Hello.'), msg(day1 + 60, 'Me', 'Hi back.'), msg(day2, 'Aina', 'Morning.', 'ooc')],
      'Aina',
      'Me',
      'markdown'
    )
    expect(out).toContain('# Aina — Me')
    expect(out).toMatch(/## 2026-05-0/)
    expect(out).toContain('Aina:** Hello.')
    expect(out).toContain('Me:** Hi back.')
    expect(out).toContain('*(OOC)*')
  })
})

describe('exportMessages text', () => {
  it('produces a text scene with [HH:MM:SS] prefixes', () => {
    const t = Math.floor(new Date('2026-05-01T10:30:00Z').getTime() / 1000)
    const out = exportMessages([msg(t, 'Aina', 'Hello.')], 'Aina', 'Me', 'text')
    expect(out).toContain('Aina — Me')
    expect(out).toMatch(/\[\d{2}:\d{2}:\d{2}\] Aina: Hello\./)
  })

  it('flags OOC messages with [OOC] in the text format', () => {
    const t = Math.floor(new Date('2026-05-01T10:30:00Z').getTime() / 1000)
    const out = exportMessages([msg(t, 'Aina', 'brb', 'ooc')], 'Aina', 'Me', 'text')
    expect(out).toContain('[OOC]')
  })
})
