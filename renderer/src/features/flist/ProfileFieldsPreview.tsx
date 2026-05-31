import { useMemo } from 'react'
import { useStore } from '../../state'
import {
  resolveInfotagDescriptors,
  type InfotagDescriptor
} from './infotagsResolver'

// Right-pane preview rendered when the user is on the Profile fields
// tab. Mirrors F-list's "Info" tab look (dark, multi-column, bold
// field name + value) so users can sanity-check how their edits will
// appear on the website without leaving the workbench.
//
// Read path is the same as ProfileFieldsTab: working-copy payload for
// values, mapping list for labels and list-item labels. Empty values
// are hidden, and groups with no filled rows drop out — matching how
// F-list itself collapses empty sections.

export function ProfileFieldsPreview() {
  const flistActiveId = useStore((s) => s.flistActiveCharacterId)
  const slot = useStore((s) => (flistActiveId ? s.flistWorking[flistActiveId] : undefined))
  const mapping = useStore((s) => s.flistMapping.payload)

  const model = useMemo(() => {
    const infotagsPayload =
      slot?.payload && typeof slot.payload === 'object'
        ? ((slot.payload.infotags as Record<string, unknown>) ?? {})
        : {}
    return resolveInfotagDescriptors(mapping, {
      overlay: slot?.overlay ?? [],
      infotagsPayload
    })
  }, [mapping, slot?.overlay, slot?.payload])

  if (!flistActiveId || !slot) {
    return (
      <div className="profile-preview profile-preview-empty">
        <p>No working copy active.</p>
      </div>
    )
  }

  const infotags = (slot.payload?.infotags as Record<string, unknown> | undefined) ?? {}

  const rendered = model.groups
    .map((g) => ({
      id: g.id,
      label: g.label,
      rows: g.descriptors
        .map((d) => ({ descriptor: d, value: resolveValue(d, infotags) }))
        .filter((r) => r.value !== null && r.value !== '')
    }))
    .filter((g) => g.rows.length > 0)

  if (rendered.length === 0) {
    return (
      <div className="profile-preview profile-preview-empty">
        <p>No filled-in profile fields yet — edit a row on the left and it'll appear here.</p>
      </div>
    )
  }

  return (
    <div className="profile-preview" data-testid="profile-fields-preview">
      <div className="profile-preview-grid">
        {rendered.map((g) => (
          <section className="profile-preview-group" key={g.id}>
            <h3 className="profile-preview-group-title">{g.label}</h3>
            <dl className="profile-preview-rows">
              {g.rows.map(({ descriptor, value }) => (
                <div className="profile-preview-row" key={descriptor.id}>
                  <dt>{descriptor.label}:</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </div>
  )
}

function resolveValue(
  descriptor: InfotagDescriptor,
  infotags: Record<string, unknown>
): string {
  const raw = infotags[descriptor.id]
  if (raw === null || raw === undefined) return ''
  const stringValue = typeof raw === 'string' ? raw : String(raw)
  if (descriptor.type === 'list' && descriptor.listItems) {
    const hit = descriptor.listItems.find((li) => li.value === stringValue)
    if (hit) return hit.label
  }
  return stringValue
}
