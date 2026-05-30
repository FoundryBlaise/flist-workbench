import { useMemo, useState } from 'react'
import {
  descriptionDiff,
  DESC_DIFF_BYTE_CAP,
  type DescDiffLine
} from './diff/descriptionDiff'

/** UX P2-5: a heavy diff (many add/rem lines) pushes the field table
 *  below the fold. Auto-collapse when the change count crosses this
 *  threshold so the user opts into the heavy view. */
const DESC_DIFF_AUTO_COLLAPSE_LINES = 20

export function DescriptionDiffView({
  workingValue,
  rightValue,
  rightLabel
}: {
  workingValue: string
  rightValue: string
  /** What to call the right-hand side in the header (e.g. "Live" or
   *  "Backup · 2026-05-29"). */
  rightLabel: string
}) {
  const out = useMemo(
    () => descriptionDiff(workingValue ?? '', rightValue ?? ''),
    [workingValue, rightValue]
  )
  const changeLines = out.lines.filter((l) => l.kind !== 'eq').length
  const [open, setOpen] = useState(
    () => changeLines > 0 && changeLines <= DESC_DIFF_AUTO_COLLAPSE_LINES
  )
  if (out.identical) {
    return (
      <div className="diff-desc diff-desc-identical">
        Description matches {rightLabel}.
      </div>
    )
  }
  // Tier 4 R-1 / QA P3-2: skip the unified view for very long
  // descriptions or when the LCS engine bailed.
  if (out.longerBytes > DESC_DIFF_BYTE_CAP || out.lines.length === 0) {
    return (
      <div className="diff-desc diff-desc-suppressed">
        Description differs from {rightLabel} ({out.longerBytes.toLocaleString()}{' '}
        bytes — too long to render inline). Toggle "Show unchanged" or use
        the per-row Reset to handle other fields first.
      </div>
    )
  }
  const addCount = out.lines.filter((l) => l.kind === 'add').length
  const remCount = out.lines.filter((l) => l.kind === 'rem').length
  return (
    <div className="diff-desc">
      <button
        type="button"
        className="diff-desc-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        data-testid="diff-desc-toggle"
      >
        {open ? '▾' : '▸'} Description vs {rightLabel} ·{' '}
        <span className="diff-desc-counts">
          <span className="diff-add-fg">+{addCount}</span>{' '}
          <span className="diff-rem-fg">−{remCount}</span>
        </span>
      </button>
      {open && (
        <ol className="diff-desc-lines" data-testid="diff-desc-lines">
          {out.lines.map((line, i) => (
            <DescLine key={i} line={line} />
          ))}
        </ol>
      )}
    </div>
  )
}

function DescLine({ line }: { line: DescDiffLine }) {
  return (
    <li className={`diff-desc-line diff-desc-line-${line.kind}`}>
      <span className="diff-desc-gutter-l">
        {line.leftLine != null ? line.leftLine : ''}
      </span>
      <span className="diff-desc-gutter-r">
        {line.rightLine != null ? line.rightLine : ''}
      </span>
      <span className="diff-desc-marker">
        {line.kind === 'add' ? '+' : line.kind === 'rem' ? '−' : ' '}
      </span>
      <span className="diff-desc-text">{line.text || ' '}</span>
    </li>
  )
}
