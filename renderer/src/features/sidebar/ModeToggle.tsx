import { useStore } from '../../state'

export function ModeToggle() {
  const mode = useStore((s) => s.mode)
  const setMode = useStore((s) => s.setMode)

  return (
    <div className="mode-toggle" role="tablist" data-testid="mode-toggle">
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'logs'}
        className={mode === 'logs' ? 'mode active' : 'mode'}
        onClick={() => setMode('logs')}
      >
        Logs
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'editor'}
        className={mode === 'editor' ? 'mode active' : 'mode'}
        onClick={() => setMode('editor')}
      >
        Editor
      </button>
    </div>
  )
}
