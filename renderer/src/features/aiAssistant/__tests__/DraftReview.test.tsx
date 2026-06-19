import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'

import { useStore } from '../../../state'
import { DraftReview } from '../DraftReview'
import type { AiDraft } from '../../../lib/api'

function draftWith(edits: AiDraft['edits']): AiDraft {
  return {
    schema_version: 1,
    base_etag: 'etag-a',
    base_working_schema_version: 6,
    created_at: '2026-06-19T00:00:00Z',
    updated_at: '2026-06-19T00:00:01Z',
    model_endpoint: 'http://stub',
    model_id: 'stub-model',
    edits
  }
}

describe('DraftReview', () => {
  beforeEach(() => {
    useStore.setState({
      aiAssistantEnabled: true,
      aiAssistantDrafts: {}
    })
  })

  afterEach(() => {
    // RTL only auto-cleans when its jest-dom shim is loaded; we run
    // bare so we have to clean manually or the prior render's DOM
    // bleeds into the next test and ambiguates queries.
    cleanup()
  })

  it('renders the empty placeholder when no edits exist', () => {
    render(<DraftReview characterId="42" draft={null} onDiscard={() => {}} />)
    expect(screen.getByText(/no proposals yet/i)).toBeTruthy()
  })

  it('renders one atomic card per non-composite edit', () => {
    const draft = draftWith([
      {
        id: 'edit-001',
        tool: 'set_infotag',
        field_path: 'infotags.49',
        kind: 'value_replace',
        old_value: '21',
        new_value: '22',
        new_label_hint: 'German',
        rationale: 'user asked',
        status: 'pending',
        composite_id: null
      }
    ])
    render(<DraftReview characterId="42" draft={draft} onDiscard={() => {}} />)
    expect(screen.getByTestId('proposal-card-edit-001')).toBeTruthy()
    expect(screen.getByText('set_infotag')).toBeTruthy()
    expect(screen.getByText(/German/)).toBeTruthy()
  })

  it('groups composite edits into one card with an expand toggle', () => {
    const draft = draftWith([
      {
        id: 'edit-001',
        tool: 'set_standard_kink',
        field_path: 'kinks.100',
        kind: 'value_replace',
        old_value: 'yes',
        new_value: 'fave',
        rationale: 'mirror',
        status: 'pending',
        composite_id: 'comp-abc'
      },
      {
        id: 'edit-002',
        tool: 'set_standard_kink',
        field_path: 'kinks.200',
        kind: 'value_replace',
        old_value: 'no',
        new_value: 'maybe',
        rationale: 'mirror',
        status: 'pending',
        composite_id: 'comp-abc'
      }
    ])
    render(<DraftReview characterId="42" draft={draft} onDiscard={() => {}} />)
    expect(screen.getByTestId('proposal-card-comp-abc')).toBeTruthy()
    expect(screen.getByText(/2 edits/i)).toBeTruthy()
  })

  it('calls the store accept action when Accept is clicked', () => {
    const accept = vi.fn()
    useStore.setState({ acceptAiAssistantEdits: accept })
    const draft = draftWith([
      {
        id: 'edit-001',
        tool: 'set_infotag',
        field_path: 'infotags.49',
        kind: 'value_replace',
        old_value: '21',
        new_value: '22',
        rationale: '',
        status: 'pending',
        composite_id: null
      }
    ])
    render(<DraftReview characterId="42" draft={draft} onDiscard={() => {}} />)
    const acceptBtns = screen.getAllByText('Accept')
    fireEvent.click(acceptBtns[0])
    expect(accept).toHaveBeenCalledWith('42', ['edit-001'])
  })

  it('shows the stale tag and disables Accept on stale edits', () => {
    const accept = vi.fn()
    useStore.setState({ acceptAiAssistantEdits: accept })
    const draft = draftWith([
      {
        id: 'edit-stale',
        tool: 'replace_description',
        field_path: 'character.description',
        kind: 'text_replace',
        old_value: 'old',
        new_value: 'new',
        rationale: '',
        status: 'stale',
        composite_id: null
      }
    ])
    render(<DraftReview characterId="42" draft={draft} onDiscard={() => {}} />)
    expect(screen.getByText('stale')).toBeTruthy()
    // Accept button is disabled — clicking should be a no-op.
    const accBtns = screen.getAllByText('Accept')
    fireEvent.click(accBtns[accBtns.length - 1])
    expect(accept).not.toHaveBeenCalled()
  })

  it('discards via the bulk button', async () => {
    const onDiscard = vi.fn()
    const draft = draftWith([
      {
        id: 'edit-001',
        tool: 'set_infotag',
        field_path: 'infotags.49',
        kind: 'value_replace',
        new_value: '22',
        rationale: '',
        status: 'pending',
        composite_id: null
      }
    ])
    render(<DraftReview characterId="42" draft={draft} onDiscard={onDiscard} />)
    // Bulk button is uniquely named "Discard draft" (composite cards
    // use "Reject all") so this query is unambiguous.
    fireEvent.click(screen.getByText('Discard draft'))
    expect(onDiscard).toHaveBeenCalled()
  })
})
