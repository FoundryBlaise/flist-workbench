import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useStore } from '../../state'

describe('AI assistant state slice (Phase 9 PR 4)', () => {
  beforeEach(() => {
    useStore.setState({
      aiAssistantEnabled: false,
      aiAssistantPaneOpen: false,
      aiAssistantTranscript: [],
      aiAssistantDrafts: {},
      aiAssistantStreaming: false,
      aiAssistantLastError: null
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('starts disabled + pane closed by default — opt-in invariant', () => {
    const s = useStore.getState()
    expect(s.aiAssistantEnabled).toBe(false)
    expect(s.aiAssistantPaneOpen).toBe(false)
  })

  it('refuses to open the pane while the master toggle is off', () => {
    useStore.getState().toggleAiAssistantPane(true)
    expect(useStore.getState().aiAssistantPaneOpen).toBe(false)
  })

  it('flipping the master toggle off also closes an already-open pane', () => {
    useStore.getState().setAiAssistantEnabled(true)
    useStore.getState().toggleAiAssistantPane(true)
    expect(useStore.getState().aiAssistantPaneOpen).toBe(true)

    useStore.getState().setAiAssistantEnabled(false)
    expect(useStore.getState().aiAssistantEnabled).toBe(false)
    expect(useStore.getState().aiAssistantPaneOpen).toBe(false)
  })

  it('toggleAiAssistantPane with no argument flips when enabled', () => {
    useStore.getState().setAiAssistantEnabled(true)
    useStore.getState().toggleAiAssistantPane()
    expect(useStore.getState().aiAssistantPaneOpen).toBe(true)
    useStore.getState().toggleAiAssistantPane()
    expect(useStore.getState().aiAssistantPaneOpen).toBe(false)
  })

  it('resetAiAssistantTranscript clears history + lastError', () => {
    useStore.setState({
      aiAssistantTranscript: [{ role: 'user', content: 'hi' }],
      aiAssistantLastError: 'boom'
    })
    useStore.getState().resetAiAssistantTranscript()
    const s = useStore.getState()
    expect(s.aiAssistantTranscript).toEqual([])
    expect(s.aiAssistantLastError).toBeNull()
  })

  it('sendAiAssistantTurn no-ops when the master toggle is off', async () => {
    await useStore.getState().sendAiAssistantTurn('hi')
    expect(useStore.getState().aiAssistantTranscript).toEqual([])
    expect(useStore.getState().aiAssistantStreaming).toBe(false)
  })

  it('sendAiAssistantTurn refuses to send without an active character', async () => {
    useStore.getState().setAiAssistantEnabled(true)
    useStore.setState({ flistActiveCharacterId: null })
    await useStore.getState().sendAiAssistantTurn('hi')
    expect(useStore.getState().aiAssistantTranscript).toEqual([])
    expect(useStore.getState().aiAssistantLastError).toMatch(/active character/i)
  })
})
