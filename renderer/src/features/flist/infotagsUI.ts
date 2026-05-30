// In-app convention, not mapping-list truth. Hand-curated UI hints
// (max-length, unit suffix, numeric range) for fields where the
// mapping list's metadata is too coarse for a usable form. Populated
// field-by-field as quirks surface; empty at ship is a no-op.
export interface InfotagUIHint {
  maxLength?: number
  unitSuffix?: string
  min?: number
  max?: number
  placeholder?: string
}

export const INFOTAG_UI_HINTS: Record<string, InfotagUIHint> = {
  // e.g. "1": { unitSuffix: "yrs", min: 18, max: 200 }  // Age
}

export function infotagHint(id: string): InfotagUIHint {
  return INFOTAG_UI_HINTS[id] ?? {}
}
