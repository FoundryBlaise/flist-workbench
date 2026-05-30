import type { ReactNode } from 'react'

/** Shared empty-state card. Codifies the visual vocabulary across
 *  the three places we need one (Documents list, RAG chat panel,
 *  F-list activity log) so a fourth empty state doesn't diverge.
 *
 *  Variants:
 *    'inline'   — borderless, fits inside a sidebar/list area
 *    'callout'  — dashed blue border, draws the eye (used when the
 *                 empty state is the only thing on screen and we want
 *                 it to read as "you need to do something")
 *    'modal'    — body-of-modal copy, no card; lets the surrounding
 *                 modal frame supply the visual containment
 */
export type EmptyStateVariant = 'inline' | 'callout' | 'modal'

export function EmptyState({
  variant = 'inline',
  headline,
  body,
  primaryCta,
  secondaryCta,
  footer,
  testId
}: {
  variant?: EmptyStateVariant
  headline?: string
  body: ReactNode
  primaryCta?: { label: string; onClick: () => void; testId?: string }
  secondaryCta?: { label: string; onClick: () => void; testId?: string }
  footer?: ReactNode
  testId?: string
}) {
  return (
    <div
      className={`empty-state empty-state-${variant}`}
      role="note"
      data-testid={testId}
    >
      {headline && (
        <p className="empty-state-headline">
          <strong>{headline}</strong>
        </p>
      )}
      <div className="empty-state-body">{body}</div>
      {(primaryCta || secondaryCta) && (
        <div className="empty-state-ctas">
          {primaryCta && (
            <button
              type="button"
              className="empty-state-cta empty-state-cta-primary"
              onClick={primaryCta.onClick}
              data-testid={primaryCta.testId}
            >
              {primaryCta.label}
            </button>
          )}
          {secondaryCta && (
            <button
              type="button"
              className="empty-state-cta"
              onClick={secondaryCta.onClick}
              data-testid={secondaryCta.testId}
            >
              {secondaryCta.label}
            </button>
          )}
        </div>
      )}
      {footer && <div className="empty-state-foot">{footer}</div>}
    </div>
  )
}
