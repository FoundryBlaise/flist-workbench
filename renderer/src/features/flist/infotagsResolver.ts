// Resolves the cached mapping-list payload into ordered, grouped
// InfotagDescriptors the Profile-fields tab can render. Memo-keyed on
// the mapping list's _etag so the work runs once per mapping refresh.

import { HAND_CODED_INFOTAG_GROUPS, lookupHandCodedGroup } from './infotagGroups'
import { infotagHint, type InfotagUIHint } from './infotagsUI'

export type InfotagFieldType = 'text' | 'list' | 'number' | 'unknown'

export interface InfotagListItem {
  /** mapping-list listitem id, kept as a string for symmetry with field
   *  values. */
  value: string
  label: string
}

export interface InfotagDescriptor {
  id: string
  fieldName: string
  label: string
  type: InfotagFieldType
  listItems?: InfotagListItem[]
  groupId: string | null
  uiHint: InfotagUIHint
}

export interface InfotagGroupResolved {
  id: string
  label: string
  descriptors: InfotagDescriptor[]
}

export interface ResolvedInfotagModel {
  descriptors: InfotagDescriptor[]
  byId: Map<string, InfotagDescriptor>
  groups: InfotagGroupResolved[]
  unknownGroup: InfotagGroupResolved
}

const OTHER_GROUP_ID = 'other'

/** Pure resolver. Walks the mapping payload's `infotags` + `listitems`
 *  arrays and produces descriptors with type fall-backs:
 *  - `type` missing or unrecognised → `unknown`
 *  - `type: list` with empty / missing listitems → `text` (defensive)
 *  - `type: number` with missing numeric range → forwarded as numeric;
 *    the UI hints fill min/max when supplied.
 */
export function resolveInfotagDescriptors(
  mapping: Record<string, unknown> | null,
  options: {
    /** Working-copy overlay paths to surface unknown fields the user
     *  has touched but the mapping list doesn't describe. */
    overlay?: string[]
    /** Working-copy infotag dict — drives the unknown-field surfacing
     *  even when the user hasn't actively edited a row yet. */
    infotagsPayload?: Record<string, unknown>
  } = {}
): ResolvedInfotagModel {
  const descriptors: InfotagDescriptor[] = []
  const byId = new Map<string, InfotagDescriptor>()
  const overlay = new Set(options.overlay ?? [])
  const infotags = (mapping?.infotags as unknown[] | undefined) ?? []
  const listitemsRaw = (mapping?.listitems as unknown[] | undefined) ?? []

  const listitemsById = new Map<string, string>()
  // F-list's mapping-list keys listitems by category name (e.g.
  // "orientation"), not by id. Each infotag's `list` field is that
  // category name — so we bucket listitems by name to resolve dropdown
  // choices in one pass. Verified by probe 2026-05-30.
  const listitemsByCategory = new Map<string, InfotagListItem[]>()
  if (Array.isArray(listitemsRaw)) {
    for (const entry of listitemsRaw) {
      if (entry && typeof entry === 'object') {
        const e = entry as { id?: unknown; name?: unknown; value?: unknown }
        if (e.id != null) listitemsById.set(String(e.id), String(e.value ?? ''))
        if (typeof e.name === 'string' && e.id != null) {
          const bucket = listitemsByCategory.get(e.name) ?? []
          bucket.push({
            value: String(e.id),
            label: String(e.value ?? '')
          })
          listitemsByCategory.set(e.name, bucket)
        }
      }
    }
  }

  if (Array.isArray(infotags)) {
    for (const raw of infotags) {
      if (!raw || typeof raw !== 'object') continue
      const e = raw as {
        id?: unknown
        name?: unknown
        type?: unknown
        list?: unknown
        group_id?: unknown
      }
      if (e.id == null) continue
      const id = String(e.id)
      const label =
        typeof e.name === 'string' && e.name.trim() ? e.name : `info_${id}`
      const declaredType = typeof e.type === 'string' ? e.type : ''
      let type: InfotagFieldType
      let listItems: InfotagListItem[] | undefined
      if (declaredType === 'list') {
        // F-list shape (verified 2026-05-30): `list` is the listitems
        // category name (e.g. "orientation"); the items live in the
        // top-level `listitems` array, bucketed by `name`. Keep the
        // older inline-array branch as a defensive fallback in case
        // F-list ever inlines them.
        let items: InfotagListItem[] = []
        if (typeof e.list === 'string' && e.list) {
          items = listitemsByCategory.get(e.list) ?? []
        } else if (Array.isArray(e.list)) {
          for (const li of e.list as unknown[]) {
            if (li && typeof li === 'object') {
              const item = li as { id?: unknown; value?: unknown }
              if (item.id != null) {
                items.push({
                  value: String(item.id),
                  label: String(item.value ?? listitemsById.get(String(item.id)) ?? item.id)
                })
              }
            } else if (typeof li === 'string' || typeof li === 'number') {
              const value = String(li)
              items.push({
                value,
                label: listitemsById.get(value) ?? value
              })
            }
          }
        }
        if (items.length === 0) {
          type = 'text'
        } else {
          type = 'list'
          listItems = items
        }
      } else if (declaredType === 'number') {
        type = 'number'
      } else if (declaredType === 'text') {
        type = 'text'
      } else {
        type = 'unknown'
      }
      const groupId =
        typeof e.group_id === 'string' && e.group_id.trim()
          ? (e.group_id as string)
          : lookupHandCodedGroup(id)
      const descriptor: InfotagDescriptor = {
        id,
        fieldName: `info_${id}`,
        label,
        type,
        listItems,
        groupId,
        uiHint: infotagHint(id)
      }
      descriptors.push(descriptor)
      byId.set(id, descriptor)
    }
  }

  // Build group buckets. Prefer mapping-supplied infotag_groups when
  // present — F-list publishes a *list* of {id, name} (verified by
  // probe 2026-05-30). We also defensively handle the object/dict
  // shape used by the older proposed schema in case F-list changes.
  // Fall back to the hand-coded constant table when neither is present.
  const mappingGroups = mapping?.infotag_groups
  const groupOrder: InfotagGroupResolved[] = []
  const groupById = new Map<string, InfotagGroupResolved>()
  if (Array.isArray(mappingGroups)) {
    for (const gv of mappingGroups as unknown[]) {
      if (gv && typeof gv === 'object') {
        const gentry = gv as { id?: unknown; name?: unknown; label?: unknown }
        if (gentry.id == null) continue
        const gid = String(gentry.id)
        const label =
          (typeof gentry.label === 'string' && gentry.label) ||
          (typeof gentry.name === 'string' && gentry.name) ||
          gid
        const group: InfotagGroupResolved = { id: gid, label, descriptors: [] }
        groupOrder.push(group)
        groupById.set(gid, group)
      }
    }
  } else if (
    mappingGroups &&
    typeof mappingGroups === 'object' &&
    !Array.isArray(mappingGroups)
  ) {
    for (const [gid, gv] of Object.entries(mappingGroups as Record<string, unknown>)) {
      if (gv && typeof gv === 'object') {
        const gentry = gv as { name?: unknown; label?: unknown }
        const label =
          (typeof gentry.label === 'string' && gentry.label) ||
          (typeof gentry.name === 'string' && gentry.name) ||
          gid
        const group: InfotagGroupResolved = { id: gid, label, descriptors: [] }
        groupOrder.push(group)
        groupById.set(gid, group)
      }
    }
  } else {
    for (const g of HAND_CODED_INFOTAG_GROUPS) {
      const group: InfotagGroupResolved = {
        id: g.id,
        label: g.label,
        descriptors: []
      }
      groupOrder.push(group)
      groupById.set(g.id, group)
    }
  }
  const otherGroup: InfotagGroupResolved = {
    id: OTHER_GROUP_ID,
    label: 'Other',
    descriptors: []
  }
  groupById.set(OTHER_GROUP_ID, otherGroup)

  for (const descriptor of descriptors) {
    if (descriptor.type === 'unknown') continue
    const target =
      (descriptor.groupId && groupById.get(descriptor.groupId)) || otherGroup
    target.descriptors.push(descriptor)
  }
  if (otherGroup.descriptors.length > 0 && !groupById.has(OTHER_GROUP_ID + ':placed')) {
    groupOrder.push(otherGroup)
    groupById.set(OTHER_GROUP_ID + ':placed', otherGroup)
  }

  // Build the unknown-fields bucket. Includes (a) descriptors with
  // type=unknown and (b) infotag ids present in the working payload or
  // overlay that aren't in the mapping at all.
  const unknownDescriptors: InfotagDescriptor[] = descriptors.filter(
    (d) => d.type === 'unknown'
  )
  const payloadInfotags =
    options.infotagsPayload && typeof options.infotagsPayload === 'object'
      ? Object.keys(options.infotagsPayload as Record<string, unknown>)
      : []
  for (const path of overlay) {
    if (!path.startsWith('infotags.')) continue
    const id = path.slice('infotags.'.length)
    if (byId.has(id)) continue
    if (unknownDescriptors.some((d) => d.id === id)) continue
    unknownDescriptors.push({
      id,
      fieldName: `info_${id}`,
      label: `info_${id}`,
      type: 'unknown',
      groupId: null,
      uiHint: infotagHint(id)
    })
  }
  for (const id of payloadInfotags) {
    if (byId.has(id)) continue
    if (unknownDescriptors.some((d) => d.id === id)) continue
    unknownDescriptors.push({
      id,
      fieldName: `info_${id}`,
      label: `info_${id}`,
      type: 'unknown',
      groupId: null,
      uiHint: infotagHint(id)
    })
  }
  const unknownGroup: InfotagGroupResolved = {
    id: 'unknown',
    label: 'Unrecognised fields',
    descriptors: unknownDescriptors
  }

  return { descriptors, byId, groups: groupOrder, unknownGroup }
}
