import type { BbcodeWarning } from '../../lib/bbcode/validate'

/**
 * What F-list's parser would say about the description, above the
 * preview. Its first warning is the one shown; the headline counts them
 * all.
 *
 * The wording follows the first warning's kind, which is F-list's order:
 * tags that are not closed, or closed in the wrong order, come first.
 * F-list does not refuse those; the profile goes live with that part as
 * plain text, so the headline says that, and the hint is about closing
 * order. Only a tag that is not allowed where it stands is refused, and
 * only there does the [big] hint apply.
 */
export function BbcodeWarningBar({ warnings }: { warnings: BbcodeWarning[] }) {
  if (warnings.length === 0) return null
  const [first] = warnings
  const plainText = first.kind !== 'not-allowed'
  const places = warnings.length > 1 ? ` — ${warnings.length} places` : ''
  return (
    <div className="preview-bbcode-warning" role="status" data-testid="preview-bbcode-warning">
      <span className="preview-bbcode-warning-icon" aria-hidden>
        ⚠
      </span>
      <span className="preview-bbcode-warning-text">
        <b>
          {plainText ? 'F-list will show this part as plain text' : 'F-list will refuse this'}
          {places}.
        </b>{' '}
        {first.message}
        {plainText
          ? ' Close every tag you open, in the reverse order you opened them:' +
            ' [b][i]…[/i][/b].'
          : warnings.length === 1 &&
            ' Only one level of formatting fits inside [big], [small],' +
              ' [sub] and [sup] — put the outer tag outside instead.'}
      </span>
    </div>
  )
}
