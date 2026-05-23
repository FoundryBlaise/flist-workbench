import { create } from 'zustand'
import { api } from './lib/api'

export type Mode = 'editor' | 'logs'

const SAMPLE_BBCODE = `[heading]F-list Workbench[/heading]
[i]Type BBCode here, watch it render on the right.[/i]

[hr]

[b]Try:[/b]
[indent][b]Bold[/b], [i]italic[/i], [u]underline[/u], [s]strike[/s].[/indent]
[indent]Coloured text in [color=red]red[/color], [color=blue]blue[/color], [color=green]green[/color].[/indent]
[indent]Inline character icons: [icon]Azure Viper[/icon] [icon]Auldren Nadir[/icon][/indent]
[indent]Emote icons: [eicon]smirk[/eicon] [eicon]wink[/eicon][/indent]
[indent]A link: [url=https://www.f-list.net]F-list[/url][/indent]

[collapse=Click to expand][center]Hidden content.[/center][/collapse]`

type State = {
  characters: string[]
  charactersStatus: 'idle' | 'loading' | 'ready' | 'error'
  charactersError: string | null

  activeCharacter: string | null
  mode: Mode

  partners: Record<string, { name: string; bytes: number }[]>
  partnersStatus: Record<string, 'loading' | 'ready' | 'error'>

  activePartner: string | null

  editorContent: string
  editorTitle: string
  editorFetchStatus: 'idle' | 'fetching' | 'ok' | 'error'
  editorFetchError: string | null

  loadCharacters: () => Promise<void>
  selectCharacter: (name: string | null) => void
  setMode: (mode: Mode) => void
  loadPartners: (char: string) => Promise<void>
  selectPartner: (name: string | null) => void
  setEditorContent: (value: string) => void
  fetchProfile: (name: string) => Promise<void>
}

export const useStore = create<State>((set, get) => ({
  characters: [],
  charactersStatus: 'idle',
  charactersError: null,

  activeCharacter: null,
  mode: 'editor',

  partners: {},
  partnersStatus: {},
  activePartner: null,

  editorContent: SAMPLE_BBCODE,
  editorTitle: 'Scratch.bbcode',
  editorFetchStatus: 'idle',
  editorFetchError: null,

  async loadCharacters() {
    set({ charactersStatus: 'loading', charactersError: null })
    try {
      const { characters } = await api.characters()
      set({
        characters,
        charactersStatus: 'ready',
        activeCharacter: get().activeCharacter ?? characters[0] ?? null
      })
    } catch (err) {
      set({
        charactersStatus: 'error',
        charactersError: err instanceof Error ? err.message : String(err)
      })
    }
  },

  selectCharacter(name) {
    set({ activeCharacter: name, activePartner: null })
  },

  setMode(mode) {
    set({ mode })
  },

  async loadPartners(char) {
    set((s) => ({ partnersStatus: { ...s.partnersStatus, [char]: 'loading' } }))
    try {
      const { partners } = await api.partners(char)
      set((s) => ({
        partners: { ...s.partners, [char]: partners },
        partnersStatus: { ...s.partnersStatus, [char]: 'ready' }
      }))
    } catch {
      set((s) => ({
        partnersStatus: { ...s.partnersStatus, [char]: 'error' }
      }))
    }
  },

  selectPartner(name) {
    set({ activePartner: name })
  },

  setEditorContent(value) {
    set({ editorContent: value })
  },

  async fetchProfile(name) {
    set({ editorFetchStatus: 'fetching', editorFetchError: null })
    try {
      const profile = await api.profile(name)
      set({
        editorContent: profile.bbcode,
        editorTitle: `${profile.name}.bbcode`,
        editorFetchStatus: 'ok',
        editorFetchError: null
      })
    } catch (err) {
      set({
        editorFetchStatus: 'error',
        editorFetchError: err instanceof Error ? err.message : String(err)
      })
    }
  }
}))
