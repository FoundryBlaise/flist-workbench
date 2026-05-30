import { useEffect, useState } from 'react'
import type { InfotagDescriptor } from '../infotagsResolver'

export function TextField({
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
        onChange={(e) => setLocal(e.target.value)}
        onBlur={() => {
          if (local !== value) onCommit(local)
        }}
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
        onChange={(e) => setLocal(e.target.value)}
        onBlur={() => {
          setShowInvalid(invalid || outOfRange)
          if (local !== value) onCommit(local)
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

function InfotagFieldShell({
  descriptor,
  overlaid,
  liveValue,
  children,
  onReset
}: {
  descriptor: InfotagDescriptor
  overlaid: boolean
  liveValue: string | null
  children: React.ReactNode
  onReset: () => void
}) {
  return (
    <div
      className={`infotag-field${overlaid ? ' infotag-field-overlaid' : ''}`}
      data-testid={`infotag-field-${descriptor.id}`}
    >
      <label className="infotag-field-label">
        <span className="infotag-field-name">{descriptor.label}</span>
        {overlaid && (
          <button
            type="button"
            className="infotag-field-reset"
            onClick={onReset}
            title="Reset to F-list value"
            aria-label={`Reset ${descriptor.label} to F-list value`}
            data-testid={`infotag-${descriptor.id}-reset`}
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
