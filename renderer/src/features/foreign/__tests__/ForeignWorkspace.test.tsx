// The editor panel in its read-only "somebody else's profile" state.
// What these cover is the shape of the promise the feature makes: it
// reads, it is visibly not the editor, and it offers no way to turn a
// stranger's profile into one of the user's own characters.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from '@testing-library/react'
import { useStore } from '../../../state'
import { api } from '../../../lib/api'
import { ForeignWorkspace } from '../ForeignWorkspace'

const PROFILE = {
  name: 'Anexample Person',
  id: 4242,
  description: '[b]Bold[/b] and plain.',
  custom_title: 'Wanderer',
  infotags: { '1': 'Human' },
  kinks: { '12': 'fave', '13': 'no' },
  custom_kinks: {},
  images: [{ image_id: '900', extension: 'png', description: 'A picture' }],
  fetched_at: 1_700_000_000
}

const MAPPING = {
  infotags: [{ id: 1, name: 'Species', type: 'text', group_id: 1 }],
  infotag_groups: [{ id: 1, name: 'General' }],
  kinks: [
    { id: 12, name: 'Biting', description: '', group_id: 3 },
    { id: 13, name: 'Vore', description: '', group_id: 3 }
  ],
  kink_groups: [{ id: 3, name: 'Body' }],
  listitems: []
}

/** Put the slot in the state it has after a successful load. */
function seedLoaded() {
  useStore.setState({
    foreignActive: true,
    foreignName: PROFILE.name,
    foreignProfile: PROFILE,
    foreignFromCache: false,
    foreignAgeSec: 0,
    foreignStale: false,
    foreignRefreshError: null,
    foreignStatus: 'ready',
    foreignError: null
  } as never)
}

beforeEach(() => {
  useStore.setState({
    foreignActive: true,
    foreignName: null,
    foreignProfile: null,
    foreignStatus: 'idle',
    foreignError: null,
    foreignStale: false,
    foreignAgeSec: null,
    foreignRefreshError: null,
    flistMapping: { status: 'ready', payload: MAPPING, error: null },
    flistLoadMapping: vi.fn().mockResolvedValue(undefined)
  } as never)
  vi.spyOn(api, 'foreignSearch').mockResolvedValue({
    source: 'bookmarks',
    query: '',
    results: ['Anexample Person', 'Someone Else'],
    truncated: false,
    exact: false
  })
  vi.spyOn(api, 'foreignProfile').mockResolvedValue({
    name: PROFILE.name,
    profile: PROFILE,
    from_cache: false,
    age_sec: 0,
    fetched_at: PROFILE.fetched_at
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

// ---- lookup step ------------------------------------------------------

it('starts on the lookup form when the slot is empty', async () => {
  render(<ForeignWorkspace />)
  expect(screen.getByTestId('foreign-lookup')).toBeDefined()
  await screen.findByRole('button', { name: 'Anexample Person' })
})

it('opens a picked character into the panel', async () => {
  render(<ForeignWorkspace />)
  fireEvent.click(await screen.findByRole('button', { name: 'Anexample Person' }))

  await waitFor(() => {
    expect(api.foreignProfile).toHaveBeenCalledWith('Anexample Person', false)
  })
  await screen.findByTestId('foreign-description')
  expect(screen.queryByTestId('foreign-lookup')).toBeNull()
})

it('switching source fetches that source once', async () => {
  render(<ForeignWorkspace />)
  await screen.findByRole('button', { name: 'Anexample Person' })

  fireEvent.click(screen.getByTestId('foreign-source-logs'))
  await waitFor(() => {
    expect(api.foreignSearch).toHaveBeenCalledWith('logs', '', expect.anything())
  })
})

it('filters without going back to the sidecar', async () => {
  // The whole performance fix. A round trip per keystroke was costing
  // seconds on the Logs source, which walks every log directory on
  // disk; the pool is fetched once and searched in the window.
  render(<ForeignWorkspace />)
  await screen.findByRole('button', { name: 'Anexample Person' })
  vi.mocked(api.foreignSearch).mockClear()

  fireEvent.change(screen.getByTestId('foreign-search-input'), {
    target: { value: 'anexample' }
  })

  await waitFor(() => {
    expect(screen.queryByRole('button', { name: 'Someone Else' })).toBeNull()
  })
  expect(screen.getByRole('button', { name: 'Anexample Person' })).toBeDefined()
  expect(api.foreignSearch).not.toHaveBeenCalled()
})

it('free text never calls the search endpoint', async () => {
  // F-list has no name search. Asking the server to echo the typed
  // string back would spend budget on nothing.
  render(<ForeignWorkspace />)
  fireEvent.click(screen.getByTestId('foreign-source-name'))
  vi.mocked(api.foreignSearch).mockClear()
  fireEvent.change(screen.getByTestId('foreign-search-input'), {
    target: { value: 'Someone New' }
  })

  await screen.findByRole('button', { name: 'Someone New' })
  expect(api.foreignSearch).not.toHaveBeenCalled()
})

it('explains a name F-list does not know', async () => {
  vi.mocked(api.foreignProfile).mockRejectedValue(
    Object.assign(new Error('HTTP 404'), { code: 'not_found' })
  )
  render(<ForeignWorkspace />)
  fireEvent.click(await screen.findByRole('button', { name: 'Anexample Person' }))

  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toContain('no character called')
})

// ---- loaded profile ---------------------------------------------------

it('is marked read-only on screen', async () => {
  // The panel looks like the editor. The one thing that must never be
  // ambiguous is that it is not one.
  seedLoaded()
  render(<ForeignWorkspace />)
  expect(screen.getByText('read-only')).toBeDefined()
})

it('shows BBCode and the rendered result side by side', async () => {
  // Same shape as the editor's Description tab: code left, render
  // right, both visible at once rather than behind a toggle.
  seedLoaded()
  render(<ForeignWorkspace />)

  const code = screen.getByTestId('foreign-bbcode-source')
  expect(code.textContent).toContain('[b]Bold[/b] and plain.')
  expect(screen.getByTestId('foreign-description').textContent).toContain('Bold')
  expect(screen.getByTestId('foreign-row').getAttribute('data-split')).toBe('split')
})

it('highlights the BBCode, and still refuses to be typed in', async () => {
  // The source pane was a plain <pre> to begin with, on the reasoning
  // that an unchangeable document needs no editor. The highlighting
  // is most of what makes nested BBCode readable, so it is the
  // editor's CodeMirror and the editor's BBCode language — with both
  // read-only locks on.
  seedLoaded()
  render(<ForeignWorkspace />)

  const code = screen.getByTestId('foreign-bbcode-source')
  expect(code.querySelector('.cm-editor')).not.toBeNull()
  const content = code.querySelector('.cm-content')
  expect(content?.getAttribute('contenteditable')).toBe('false')
})

it('lays the profile fields out as a vertical list', async () => {
  seedLoaded()
  render(<ForeignWorkspace />)
  fireEvent.click(screen.getByRole('tab', { name: 'Profile fields' }))

  const pane = await screen.findByTestId('foreign-fields')
  // The editor's own field markup, so a label reads the same on a
  // stranger's profile as on the user's own.
  const species = await screen.findByTestId('foreign-field-Species')
  expect(species.querySelector('.infotag-field-name')?.textContent).toBe('Species')
  expect(pane.classList.contains('foreign-fields-vertical')).toBe(true)
  expect(screen.getByTestId('foreign-row').getAttribute('data-split')).toBe('split')
})

it('renders the Info preview beside the profile fields', async () => {
  // The editor's own preview component, fed the foreign payload —
  // one implementation for both sides instead of two that drift.
  seedLoaded()
  render(<ForeignWorkspace />)
  fireEvent.click(screen.getByRole('tab', { name: 'Profile fields' }))

  const preview = await screen.findByTestId('profile-fields-preview')
  expect(preview.textContent).toContain('Species')
  expect(preview.textContent).toContain('Human')
})

it('offers the F-list theme switch on the description', async () => {
  seedLoaded()
  render(<ForeignWorkspace />)

  const sw = screen.getByTestId('foreign-theme-switch')
  expect(sw).toBeDefined()
  const pane = screen.getByTestId('foreign-preview-pane')
  expect(pane.getAttribute('data-flist-theme')).toBe(
    useStore.getState().previewTheme
  )

  fireEvent.click(within(sw).getByRole('button', { name: 'Light' }))
  expect(useStore.getState().previewTheme).toBe('light')
  expect(
    screen.getByTestId('foreign-preview-pane').getAttribute('data-flist-theme')
  ).toBe('light')
})

it('gives kinks and images the full width', async () => {
  seedLoaded()
  render(<ForeignWorkspace />)
  fireEvent.click(screen.getByRole('tab', { name: /Kinks/ }))
  expect(screen.getByTestId('foreign-row').getAttribute('data-split')).toBe('full')
})

it('loads every gallery image rather than deferring them', async () => {
  // Gallery images come off the CDN, which is a separate budget from
  // the 200 character-data calls an hour — deferring them buys
  // nothing against the quota that limits how many profiles open.
  seedLoaded()
  render(<ForeignWorkspace />)
  fireEvent.click(screen.getByRole('tab', { name: /Images/ }))

  const pane = await screen.findByTestId('foreign-images')
  const img = pane.querySelector('img')
  expect(img).not.toBeNull()
  expect(img?.getAttribute('loading')).toBeNull()
})

it('refresh asks the sidecar to bypass the cache', async () => {
  seedLoaded()
  render(<ForeignWorkspace />)
  fireEvent.click(screen.getByTestId('foreign-refresh'))
  await waitFor(() => {
    expect(api.foreignProfile).toHaveBeenCalledWith('Anexample Person', true)
  })
})

it('"Look up another" empties the slot back to the form', async () => {
  seedLoaded()
  render(<ForeignWorkspace />)
  fireEvent.click(screen.getByTestId('foreign-lookup-another'))

  expect(screen.getByTestId('foreign-lookup')).toBeDefined()
  expect(useStore.getState().foreignProfile).toBeNull()
})

it('lays kinks out in the editor four columns', async () => {
  // The first version listed every chosen kink in one flowing grid
  // with its description underneath — on a profile with 95 favourites
  // that was a wall of text nobody could scan.
  seedLoaded()
  render(<ForeignWorkspace />)
  fireEvent.click(screen.getByRole('tab', { name: /Kinks/ }))

  const pane = await screen.findByTestId('foreign-kinks')
  expect(pane.classList.contains('kinks-pane')).toBe(true)
  for (const bucket of ['fave', 'yes', 'maybe', 'no']) {
    expect(screen.getByTestId(`foreign-kink-column-${bucket}`)).toBeDefined()
  }

  const fave = screen.getByTestId('foreign-kink-column-fave')
  expect(fave.querySelector('.kink-row-name')?.textContent).toBe('Biting')
  expect(fave.querySelector('.kink-column-count')?.textContent).toBe('1')
  expect(
    screen
      .getByTestId('foreign-kink-column-no')
      .querySelector('.kink-row-name')?.textContent
  ).toBe('Vore')
  // Descriptions live on the row title, not inline — that is what
  // makes the column scannable.
  expect(pane.textContent).not.toContain('Undecided')
})

it('shows only the kinks the character actually chose', async () => {
  seedLoaded()
  render(<ForeignWorkspace />)
  fireEvent.click(screen.getByRole('tab', { name: /Kinks/ }))

  const pane = await screen.findByTestId('foreign-kinks')
  // Two catalogue kinks, both chosen. An untouched one must not show
  // up as a phantom row.
  expect(pane.querySelectorAll('.kink-row')).toHaveLength(2)
})

it('resolves infotag ids to their mapping names', async () => {
  seedLoaded()
  render(<ForeignWorkspace />)
  fireEvent.click(screen.getByRole('tab', { name: 'Profile fields' }))

  const species = await screen.findByTestId('foreign-field-Species')
  expect(
    species.querySelector<HTMLInputElement>('.infotag-field-input')?.value
  ).toBe('Human')
  // The custom title rides along in the same list, as it does in the
  // editor.
  const title = screen.getByTestId('foreign-field-Custom title')
  expect(
    title.querySelector<HTMLInputElement>('.infotag-field-input')?.value
  ).toBe('Wanderer')
})

it('has no Diff tab, because there is nothing to diff against', async () => {
  seedLoaded()
  render(<ForeignWorkspace />)
  expect(screen.queryByRole('tab', { name: /Diff/ })).toBeNull()
})

it('offers nothing that copies the profile anywhere', async () => {
  // The whole constraint of the feature in one assertion. If someone
  // later adds an import or back-up affordance to this panel, this is
  // what should stop them.
  seedLoaded()
  render(<ForeignWorkspace />)
  const panel = screen.getByTestId('foreign-workspace')
  const labels = Array.from(panel.querySelectorAll('button')).map((b) =>
    (b.textContent ?? '').toLowerCase()
  )
  for (const forbidden of [
    'copy',
    'import',
    'export',
    'back up',
    'backup',
    'working set',
    'save',
    'adopt',
    'duplicate',
    'pull'
  ]) {
    expect(labels.some((l) => l.includes(forbidden))).toBe(false)
  }
})

// ---- the slot is not a character --------------------------------------

it('never sets an active F-list character id', async () => {
  // This is what keeps every edit, pull, backup and export path from
  // finding anything to act on.
  useStore.setState({ flistActiveCharacterId: null } as never)
  render(<ForeignWorkspace />)
  fireEvent.click(await screen.findByRole('button', { name: 'Anexample Person' }))
  await screen.findByTestId('foreign-description')

  const s = useStore.getState()
  expect(s.flistActiveCharacterId).toBeNull()
  expect(s.flistWorking['4242']).toBeUndefined()
})

it('picking a real character leaves the slot but keeps what it held', async () => {
  seedLoaded()
  act(() => {
    useStore.getState().selectCharacter('Someone Real')
  })

  const s = useStore.getState()
  expect(s.foreignActive).toBe(false)
  // Kept, so going back costs no second F-list call.
  expect(s.foreignName).toBe('Anexample Person')
})
