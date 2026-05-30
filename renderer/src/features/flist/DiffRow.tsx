import type { DiffRow as DiffRowModel, DiffKind } from './diff/diffEngine'

const KIND_BADGE: Record<DiffKind, string> = {
  unchanged: '◯',
  modified: '●',
  added: '+',
  removed: '−'
}

const KIND_CLASS: Record<DiffKind, string> = {
  unchanged: 'diff-row-unchanged',
  modified: 'diff-row-modified',
  added: 'diff-row-added',
  removed: 'diff-row-removed'
}

function renderValue(value: unknown): string {
  if (value === undefined || value === null) return '—'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') {
    if (value.length === 0) return '(empty)'
    return value.length > 120 ? value.slice(0, 117) + '…' : value
  }
  if (typeof value === 'number') return String(value)
  // Whole-entry custom_kink rows pass the entry object through; surface
  // a short summary so the row doesn't render '[object Object]'.
  try {
    const json = JSON.stringify(value)
    return json.length > 120 ? json.slice(0, 117) + '…' : json
  } catch {
    return String(value)
  }
}

export function DiffRow({
  row,
  rightLabel,
  onReset,
  backupResetDisabled = false
}: {
  row: DiffRowModel
  /** What to call the right-hand source in the row. */
  rightLabel: string
  onReset: (() => void) | null
  /** True when the right source is a Backup — per-row reset isn't
   *  supported there; render a disabled button so the user gets a
   *  signal rather than wondering why the affordance is missing. */
  backupResetDisabled?: boolean
}) {
  return (
    <tr
      className={`diff-row ${KIND_CLASS[row.kind]}`}
      data-testid={`diff-row-${row.path}`}
      data-kind={row.kind}
    >
      <td className="diff-cell diff-cell-kind" aria-label={`kind: ${row.kind}`}>
        <span className={`diff-badge diff-badge-${row.kind}`}>
          {KIND_BADGE[row.kind]}
        </span>
      </td>
      <td className="diff-cell diff-cell-label">{row.label}</td>
      <td className="diff-cell diff-cell-working" title={String(row.workingValue ?? '')}>
        {renderValue(row.workingValue)}
      </td>
      <td
        className="diff-cell diff-cell-right"
        title={String(row.rightValue ?? '')}
      >
        {renderValue(row.rightValue)}
      </td>
      <td className="diff-cell diff-cell-action">
        {onReset && row.inOverlay && row.kind !== 'unchanged' && (
          <button
            type="button"
            className="diff-row-reset"
            onClick={onReset}
            title={`Reset this row to ${rightLabel}`}
            data-testid={`diff-row-reset-${row.path}`}
          >
            ↺ Reset
          </button>
        )}
        {!onReset && backupResetDisabled && row.inOverlay && row.kind !== 'unchanged' && (
          <button
            type="button"
            className="diff-row-reset diff-row-reset-disabled"
            disabled
            title={
              "Per-row reset against Backups isn't supported yet — use " +
              `'Discard all changes vs ${rightLabel}' to roll back.`
            }
          >
            ↺ Reset
          </button>
        )}
      </td>
    </tr>
  )
}
