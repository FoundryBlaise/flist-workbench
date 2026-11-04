import { useEffect, useState } from 'react'
import { WORKBENCH_UNDO_MARK } from '../../../lib/undoRedo'
import type { InfotagDescriptor } from '../infotagsResolver'

/** How a field hands its value to the Workbench. A text field calls it
 *  on every keystroke with `typing`, so what is typed is in the
 *  Workbench at once: an autosave, a close or a model's change merged
 *  in meanwhile all see it as mine. */
export type FieldCommit = (next: string, opts?: { typing: true }) => void

export function TextField({
  descriptor,
  value,
  overlaid,
  liveValue,
  readOnly,
  onCommit,
  onEndTyping,
  onReset
}: {
  descriptor: InfotagDescriptor
  value: string
  overlaid: boolean
  liveValue: string | null
  readOnly: boolean
  onCommit: FieldCommit
  onEndTyping?: () => void
  onReset: () => void
}) {
  const [local, setLocal] = useState(value)
  useEffect(() => {
    setLocal(value)
  }, [value, descriptor.id])
  return (
    <InfotagFieldShell
      descriptor={descriptor}
      overlaid={overlaid}
      liveValue={liveValue}
      onReset={onReset}
    >
      <input
        type="text"
        className="infotag-field-input"
        value={local}
        placeholder={descriptor.uiHint.placeholder ?? '—'}
        maxLength={descriptor.uiHint.maxLength}
        disabled={readOnly}
        data-testid={`infotag-${descriptor.id}-input`}
        {...WORKBENCH_UNDO_MARK}
        onChange={(e) => {
          setLocal(e.target.value)
          onCommit(e.target.value, { typing: true })
        }}
        onBlur={() => onEndTyping?.()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            ;(e.currentTarget as HTMLInputElement).blur()
          }
        }}
      />
    </InfotagFieldShell>
  )
}

export function NumberField({
  descriptor,
  value,
  overlaid,
  liveValue,
  readOnly,
  onCommit,
  onEndTyping,
  onReset
}: {
  descriptor: InfotagDescriptor
  value: string
  overlaid: boolean
  liveValue: string | null
  readOnly: boolean
  onCommit: FieldCommit
  onEndTyping?: () => void
  onReset: () => void
}) {
  const [local, setLocal] = useState(value)
  const [showInvalid, setShowInvalid] = useState(false)
  useEffect(() => {
    setLocal(value)
    setShowInvalid(false)
  }, [value, descriptor.id])
  const num = Number(local)
  const isNumeric = local === '' || !Number.isNaN(num)
  const min = descriptor.uiHint.min
  const max = descriptor.uiHint.max
  const outOfRange =
    isNumeric &&
    local !== '' &&
    ((typeof min === 'number' && num < min) ||
      (typeof max === 'number' && num > max))
  const invalid = !isNumeric
  const errorCopy = (() => {
    if (invalid) return `“${local}” isn't a number`
    if (outOfRange) {
      if (typeof min === 'number' && typeof max === 'number')
        return `must be between ${min} and ${max}`
      if (typeof min === 'number') return `must be ≥ ${min}`
      if (typeof max === 'number') return `must be ≤ ${max}`
    }
    return null
  })()
  return (
    <InfotagFieldShell
      descriptor={descriptor}
      overlaid={overlaid}
      liveValue={liveValue}
      onReset={onReset}
    >
      <input
        type="text"
        inputMode="numeric"
        className="infotag-field-input"
        value={local}
        placeholder={descriptor.uiHint.placeholder ?? '—'}
        disabled={readOnly}
        data-testid={`infotag-${descriptor.id}-input`}
        {...WORKBENCH_UNDO_MARK}
        onChange={(e) => {
          setLocal(e.target.value)
          onCommit(e.target.value, { typing: true })
        }}
        onBlur={() => {
          setShowInvalid(invalid || outOfRange)
          onEndTyping?.()
        }}
      />
      {descriptor.uiHint.unitSuffix && (
        <span className="infotag-field-unit">{descriptor.uiHint.unitSuffix}</span>
      )}
      {showInvalid && errorCopy && (
        <span className="infotag-field-error">{errorCopy}</span>
      )}
    </InfotagFieldShell>
  )
}

export function ListField({
  descriptor,
  value,
  overlaid,
  liveValue,
  readOnly,
  onCommit,
  onReset
}: {
  descriptor: InfotagDescriptor
  value: string
  overlaid: boolean
  liveValue: string | null
  readOnly: boolean
  onCommit: (next: string) => void
  onReset: () => void
}) {
  const items = descriptor.listItems ?? []
  return (
    <InfotagFieldShell
      descriptor={descriptor}
      overlaid={overlaid}
      liveValue={liveValue}
      onReset={onReset}
    >
      <select
        className="infotag-field-select"
        value={value}
        disabled={readOnly}
        data-testid={`infotag-${descriptor.id}-select`}
        onChange={(e) => onCommit(e.target.value)}
      >
        <option value="">—</option>
        {items.map((item) => (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        ))}
      </select>
    </InfotagFieldShell>
  )
}

export function UnknownField({
  descriptor,
  value,
  overlaid,
  onForceRefreshMapping
}: {
  descriptor: InfotagDescriptor
  value: string
  overlaid: boolean
  onForceRefreshMapping: () => void
}) {
  return (
    <div
      className={`infotag-field infotag-field-unknown${
        overlaid ? ' infotag-field-overlaid' : ''
      }`}
      data-testid={`infotag-${descriptor.id}-unknown`}
    >
      <label className="infotag-field-label">
        <span className="infotag-field-name">{descriptor.fieldName}</span>
      </label>
      <div className="infotag-field-control">
        <input
          type="text"
          className="infotag-field-input"
          value={value}
          disabled
          aria-readonly
        />
      </div>
      <p className="infotag-field-meta">
        Unrecognised field — update mapping list to edit.{' '}
        <button
          type="button"
          className="infotag-field-meta-action"
          onClick={onForceRefreshMapping}
        >
          ↻ Refresh mapping list
        </button>
      </p>
    </div>
  )
}

/** The label-over-control frame every infotag field sits in. The
 *  editor's fields pass their descriptor; the Foreign view passes a
 *  label and a read-only input, so a field reads the same on both. */
export function InfotagFieldShell({
  descriptor,
  label = descriptor?.label ?? '',
  testId = descriptor ? `infotag-field-${descriptor.id}` : undefined,
  overlaid = false,
  liveValue = null,
  children,
  onReset
}: {
  descriptor?: InfotagDescriptor
  label?: string
  testId?: string
  overlaid?: boolean
  liveValue?: string | null
  children: React.ReactNode
  onReset?: () => void
}) {
  return (
    <div
      className={`infotag-field${overlaid ? ' infotag-field-overlaid' : ''}`}
      data-testid={testId}
    >
      <label className="infotag-field-label">
        <span className="infotag-field-name">{label}</span>
        {overlaid && (
          <button
            type="button"
            className="infotag-field-reset"
            onClick={onReset}
            title="Reset to F-list value"
            aria-label={`Reset ${label} to F-list value`}
            data-testid={descriptor ? `infotag-${descriptor.id}-reset` : undefined}
          >
            ↺ reset
          </button>
        )}
      </label>
      <div className="infotag-field-control">{children}</div>
      {overlaid && (
        <p className="infotag-field-meta">
          <span className="infotag-field-meta-live">
            F-list: {liveValue ?? '—'}
          </span>
        </p>
      )}
    </div>
  )
}
