import { create } from 'zustand'
import { api } from './lib/api'

export type Mode = 'editor' | 'logs'

type State = {
  characters: string[]
  charactersStatus: 'idle' | 'loading' | 'ready' | 'error'
  charactersError: string | null

  activeCharacter: string | null
  mode: Mode

  partners: Record<string, { name: string; bytes: number }[]>
  partnersStatus: Record<string, 'loading' | 'ready' | 'error'>

  activePartner: string | null

  loadCharacters: () => Promise<void>
  selectCharacter: (name: string | null) => void
  setMode: (mode: Mode) => void
  loadPartners: (char: string) => Promise<void>
  selectPartner: (name: string | null) => void
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
  }
}))
