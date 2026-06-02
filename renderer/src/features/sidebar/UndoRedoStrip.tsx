export interface UndoRedoStripProps {
  canUndo: boolean
  canRedo: boolean
  undoCount: number
  redoCount: number
  undoHint?: string
  redoHint?: string
  onUndo: () => void
  onRedo: () => void
}

export function UndoRedoStrip({
  canUndo,
  canRedo,
  undoCount,
  redoCount,
  undoHint,
  redoHint,
  onUndo,
  onRedo
}: UndoRedoStripProps) {
  const total = undoCount + redoCount
  return (
    <div
      className="t7-undo-redo"
      role="toolbar"
      aria-label="Undo and redo for the active working set"
      data-testid="t7-undo-redo"
    >
      <button
        type="button"
        className="t7-undo-redo-btn"
        onClick={onUndo}
        disabled={!canUndo}
        title={undoHint || (canUndo ? 'Undo' : 'Nothing to undo')}
        data-testid="t7-undo-btn"
        aria-label="Undo"
      >
        ⤺
      </button>
      <span className="t7-undo-redo-sep" aria-hidden="true">·</span>
      <button
        type="button"
        className="t7-undo-redo-btn"
        onClick={onRedo}
        disabled={!canRedo}
        title={redoHint || (canRedo ? 'Redo' : 'Nothing to redo')}
        data-testid="t7-redo-btn"
        aria-label="Redo"
      >
        ⤻
      </button>
      <span className="t7-undo-redo-count">
        {total === 0 ? 'no edits' : `${undoCount} ${undoCount === 1 ? 'edit' : 'edits'}`}
      </span>
    </div>
  )
}
