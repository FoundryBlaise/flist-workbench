// Fallback infotag groupings, used only when the mapping-list payload
// drops the `infotag_groups` key. The probe on 2026-05-30 confirmed the
// payload currently ships them as a list of `{id, name}`; this constant
// mirrors what was returned so a payload regression doesn't blank the
// Profile-fields tab.
//
// Group ids are F-list-assigned strings ("1", "2", "3", "5"). Tier 2
// does NOT enumerate the infotag→group mapping here — that comes from
// each infotag entry's `group_id` field; this table only names the
// groups. Renderer drops unknown group_ids into the "Other" section.

export interface InfotagGroup {
  id: string
  label: string
  /** Optional id list, only consulted when neither the mapping list
   *  carries `infotag_groups` nor each infotag carries `group_id`. */
  infotagIds?: string[]
}

export const HAND_CODED_INFOTAG_GROUPS: InfotagGroup[] = [
  { id: '1', label: 'Contact details/Sites' },
  { id: '2', label: 'Sexual details' },
  { id: '3', label: 'General details' },
  { id: '5', label: 'RPing preferences' }
]

/** Returns the fallback group id for an infotag — Tier 2 derives group
 *  membership from the mapping-list entry itself via `group_id`, so this
 *  is invoked only when neither source is available. */
export function lookupHandCodedGroup(infotagId: string): string | null {
  for (const group of HAND_CODED_INFOTAG_GROUPS) {
    if (group.infotagIds?.includes(infotagId)) return group.id
  }
  return null
}
