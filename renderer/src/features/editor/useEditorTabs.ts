import { useEffect, useMemo, useState } from 'react'
import { selectWorkingSlot, useStore } from '../../state'
import { countKinksWithChoice } from '../flist/kinksUnified'
import { countDiffChanges } from '../flist/DiffPane'

export type EditorTabId =
  | 'description'
  | 'profile-fields'
  | 'kinks'
  | 'images'
  | 'diff'

export interface EditorTabMeta {
  id: EditorTabId
  label: string
  badge?: number
}

/** Single source of truth for the editor's tab list + active tab.
 *  Used by both the full-width tabs bar in AppLayout and by EditorPane
 *  / PreviewPane to know which tab's content to render. */
export function useEditorTabs(): {
  tabs: EditorTabMeta[]
  activeTab: EditorTabId
  setActiveTab: (id: EditorTabId) => void
  flistTabsVisible: boolean
} {
  const flistActiveId = useStore((s) => s.flistActiveCharacterId)
  const activeDocIdRaw = useStore((s) => s.activeDocId)
  const flistTabsVisible = flistActiveId !== null && activeDocIdRaw === null
  const workingSlot = useStore((s) =>
    flistActiveId ? selectWorkingSlot(s, flistActiveId) : undefined
  )
  const kinksCount = countKinksWithChoice(workingSlot)
  const diffChangeCount = countDiffChanges(workingSlot)

  const tabs = useMemo<EditorTabMeta[]>(() => {
    const out: EditorTabMeta[] = [
      { id: 'description', label: 'Description (BBCode)' }
    ]
    if (flistTabsVisible && flistActiveId) {
      out.push({ id: 'profile-fields', label: 'Profile fields' })
      out.push({
        id: 'kinks',
        label: 'Kinks',
        badge: kinksCount > 0 ? kinksCount : undefined
      })
      out.push({ id: 'images', label: 'Images' })
      out.push({
        id: 'diff',
        label: 'Diff',
        badge: diffChangeCount > 0 ? diffChangeCount : undefined
      })
    }
    return out
  }, [flistTabsVisible, flistActiveId, kinksCount, diffChangeCount])

  const tabKey = flistActiveId
    ? `flist-workbench:active-editor-tab:${flistActiveId}`
    : 'flist-workbench:active-editor-tab'
  const editorActiveTab = useStore((s) => s.editorActiveTab) as EditorTabId
  const setEditorActiveTab = useStore((s) => s.setEditorActiveTab)

  const [hydrated, setHydrated] = useState(false)

  useEffect(() => {
    try {
      const stored = localStorage.getItem(tabKey)
      if (stored && stored !== editorActiveTab) {
        setEditorActiveTab(stored)
      } else if (!stored && editorActiveTab !== 'description') {
        setEditorActiveTab('description')
      }
    } catch {
      // ignore
    }
    setHydrated(true)
    // intentionally re-run on character switch only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabKey])

  useEffect(() => {
    if (!hydrated) return
    try {
      localStorage.setItem(tabKey, editorActiveTab)
    } catch {
      // ignore
    }
  }, [editorActiveTab, tabKey, hydrated])

  useEffect(() => {
    if (!flistTabsVisible && editorActiveTab !== 'description') {
      setEditorActiveTab('description')
    }
  }, [flistTabsVisible, editorActiveTab, setEditorActiveTab])

  return {
    tabs,
    activeTab: editorActiveTab,
    setActiveTab: (id) => setEditorActiveTab(id),
    flistTabsVisible
  }
}
