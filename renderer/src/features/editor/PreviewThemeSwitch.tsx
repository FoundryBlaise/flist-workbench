import { useStore } from '../../state'

const THEMES = ['dark', 'default', 'light'] as const

/** Dark / Default / Light: which F-list theme the rendered description
 *  imitates. The editor's preview and the Foreign view share it, and
 *  the choice with it; the pane around it carries `data-flist-theme`. */
export function PreviewThemeSwitch({ testId }: { testId: string }) {
  const previewTheme = useStore((s) => s.previewTheme)
  const setPreviewTheme = useStore((s) => s.setPreviewTheme)
  return (
    <div
      className="preview-theme-switch"
      role="group"
      aria-label="F-list theme"
      data-testid={testId}
    >
      {THEMES.map((t) => (
        <button
          key={t}
          type="button"
          className={`preview-theme-btn${previewTheme === t ? ' on' : ''}`}
          aria-pressed={previewTheme === t}
          title={`Preview as F-list ${t[0].toUpperCase() + t.slice(1)} theme`}
          onClick={() => setPreviewTheme(t)}
        >
          {t[0].toUpperCase() + t.slice(1)}
        </button>
      ))}
    </div>
  )
}
