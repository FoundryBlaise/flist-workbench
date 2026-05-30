// Five-choice colour-coded group used by KinkListRail row dots,
// KinkDetailPane, BulkActionBar, and StandardKinksColumn headers. The
// rest of the kink UI inherits this palette.

import { useEffect, useRef } from 'react'

export type KinkChoice = 'fave' | 'yes' | 'maybe' | 'no' | 'undecided'

export const CHOICE_LABELS: Record<KinkChoice, string> = {
  fave: '★ Fave',
  yes: 'Yes',
  maybe: 'Maybe',
  no: 'No',
  undecided: '– Undecided'
}

// Compact variant labels — explicit map vs regex-strip of CHOICE_LABELS
// (QA P3-2: prefix-glyph changes would otherwise silently break compact).
export const CHOICE_LABELS_COMPACT: Record<KinkChoice, string> = {
  fave: 'Fave',
  yes: 'Yes',
  maybe: 'Maybe',
  no: 'No',
  undecided: 'Undecided'
}

export const CHOICE_ORDER: KinkChoice[] = ['fave', 'yes', 'maybe', 'no', 'undecided']

export function isKinkChoice(value: unknown): value is KinkChoice {
  return (
    value === 'fave' ||
    value === 'yes' ||
    value === 'maybe' ||
    value === 'no' ||
    value === 'undecided'
  )
}

export function ChoiceButtons({
  value,
  onChange,
  disabled,
  variant = 'full',
  testId
}: {
  value: KinkChoice
  onChange: (next: KinkChoice) => void
  disabled?: boolean
  variant?: 'full' | 'compact'
  testId?: string
}) {
  // Roving-tabindex pattern for the radiogroup (UX P3-2): only the
  // active button receives `tabIndex=0`, and Left/Right arrows move
  // focus + commit the choice. Tab steps in/out as a single stop.
  const groupRef = useRef<HTMLDivElement | null>(null)
  const focusChoice = (next: KinkChoice) => {
    onChange(next)
    requestAnimationFrame(() => {
      const node = groupRef.current?.querySelector<HTMLButtonElement>(
        `[data-choice="${next}"]`
      )
      node?.focus()
    })
  }
  useEffect(() => {
    if (!groupRef.current) return
    // No imperative focus on mount — only respond to user-driven arrows.
  }, [])
  return (
    <div
      ref={groupRef}
      className={`kink-choice-buttons kink-choice-buttons-${variant}`}
      role="radiogroup"
      aria-label="Choice"
      data-testid={testId}
      onKeyDown={(e) => {
        if (disabled) return
        const idx = CHOICE_ORDER.indexOf(value)
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault()
          focusChoice(CHOICE_ORDER[(idx + 1) % CHOICE_ORDER.length])
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault()
          focusChoice(
            CHOICE_ORDER[(idx - 1 + CHOICE_ORDER.length) % CHOICE_ORDER.length]
          )
        } else if (e.key === 'Home') {
          e.preventDefault()
          focusChoice(CHOICE_ORDER[0])
        } else if (e.key === 'End') {
          e.preventDefault()
          focusChoice(CHOICE_ORDER[CHOICE_ORDER.length - 1])
        }
      }}
    >
      {CHOICE_ORDER.map((choice) => {
        const active = choice === value
        return (
          <button
            key={choice}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            data-choice={choice}
            disabled={disabled}
            className={`kink-choice-button kink-choice-${choice}${
              active ? ' kink-choice-button-active' : ''
            }`}
            onClick={() => onChange(choice)}
            data-testid={`choice-${choice}`}
          >
            {variant === 'full' ? CHOICE_LABELS[choice] : CHOICE_LABELS_COMPACT[choice]}
          </button>
        )
      })}
    </div>
  )
}
