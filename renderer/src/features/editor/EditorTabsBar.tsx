import { Tabs, type TabsTab } from '../../components/Tabs'
import { useEditorTabs } from './useEditorTabs'
import { ViewModeToggle } from './Toolbar'

/** Full-width tabs row that sits above the editor + preview row.
 *  Pure navigation — the actual content for each tab is rendered by
 *  EditorPane (left) and PreviewPane (right). On the Description tab
 *  the right side carries a Split / Code / Preview toggle; we render
 *  it here rather than on the BBCode toolbar so it stays reachable in
 *  full-preview mode (where the toolbar pane is hidden). */
export function EditorTabsBar() {
  const { tabs, activeTab, setActiveTab } = useEditorTabs()
  if (tabs.length <= 1) return null
  const tabItems: TabsTab[] = tabs.map((t) => ({
    id: t.id,
    label: t.label,
    badge: t.badge,
    content: null
  }))
  return (
    <Tabs
      tabs={tabItems}
      activeId={activeTab}
      onChange={(id) => setActiveTab(id as typeof activeTab)}
      stripOnly
      stripActions={activeTab === 'description' ? <ViewModeToggle /> : null}
      testId="editor-tabs-bar"
    />
  )
}
