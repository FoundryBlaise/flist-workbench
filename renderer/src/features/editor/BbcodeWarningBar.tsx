import type { BbcodeWarning } from '../../lib/bbcode/validate'

const CLOSING_HINT =
  ' Close every tag you open, in the reverse order you opened them: [b][i]…[/i][/b].'
const NESTING_HINT =
  ' Only one level of formatting fits inside [big], [small],' +
  ' [sub] and [sup] — put the outer tag outside instead.'

/**
 * What F-list's parser would say about the description, above the
 * preview. Its first warning is the one shown; the headline counts them
 * all.
 *
 * The wording follows the kinds of warning present. Tags that are not
 * closed, or closed in the wrong order, are not refused: the profile
 * goes live with that part as plain text, so the headline says that,
 * and the hint is about closing order. A tag that is not allowed where
 * it stands is refused, and only there does the [big] hint apply. When
 * both occur the headline says both and both hints follow, as the
 * sidecar's explanation does; F-list lists the structural warnings
 * first, so the one quoted is a structural one.
 */
export function BbcodeWarningBar({ warnings }: { warnings: BbcodeWarning[] }) {
  if (warnings.length === 0) return null
  const [first] = warnings
  const plainText = warnings.some((w) => w.kind !== 'not-allowed')
  const refused = warnings.some((w) => w.kind === 'not-allowed')
  const places = warnings.length > 1 ? ` — ${warnings.length} places` : ''
  const headline =
    plainText && refused
      ? 'F-list will refuse part of this and show part as plain text'
      : plainText
        ? 'F-list will show this part as plain text'
        : 'F-list will refuse this'
  return (
    <div className="preview-bbcode-warning" role="status" data-testid="preview-bbcode-warning">
      <span className="preview-bbcode-warning-icon" aria-hidden>
        ⚠
      </span>
      <span className="preview-bbcode-warning-text">
        <b>
          {headline}
          {places}.
        </b>{' '}
        {first.message}
        {plainText && CLOSING_HINT}
        {refused && (plainText || warnings.length === 1) && NESTING_HINT}
      </span>
    </div>
  )
}
