import { useEffect } from 'react'
import { useStore } from '../../state'
import { KinkListRail } from './KinkListRail'
import { KinkDetailPane } from './KinkDetailPane'
import { BulkActionBar } from './BulkActionBar'
import { TombstoneUndoBanner } from './TombstoneUndoBanner'

export function CustomKinksPane({ characterId }: { characterId: string }) {
  const ui = useStore((s) => s.flistCustomKinksUI[characterId])
  const slot = useStore((s) => s.flistWorking[characterId])
  const setUI = useStore((s) => s.flistCustomKinksSetUI)
  const select = useStore((s) => s.flistCustomKinksSelect)
  const mappingStatus = useStore((s) => s.flistMapping.status)
  const loadMapping = useStore((s) => s.flistLoadMapping)

  useEffect(() => {
    if (mappingStatus === 'idle') void loadMapping()
  }, [mappingStatus, loadMapping])

  // Auto-select the first kink so an empty detail pane never appears
  // when the rail has options. Picks the first non-tombstoned id from
  // _custom_kinks_order. Runs once per character switch.
  useEffect(() => {
    if (!slot) return
    const ck =
      (slot.payload.custom_kinks as Record<string, Record<string, unknown>> | undefined) ?? {}
    // If a previously-selected id no longer exists or is tombstoned,
    // clear the selection so the detail pane doesn't keep showing
    // "This kink was removed" forever (QA P2-2).
    if (ui?.selectedKinkId) {
      const entry = ck[ui.selectedKinkId]
      if (entry && entry._deleted !== true) return
      // fall through and re-pick
    }
    const order = Array.isArray(slot.payload._custom_kinks_order)
      ? (slot.payload._custom_kinks_order as string[])
      : Object.keys(ck)
    const orderSet = new Set(order)
    const allIds = [...order, ...Object.keys(ck).filter((id) => !orderSet.has(id))]
    for (const id of allIds) {
      if (ck[id] && ck[id]._deleted !== true) {
        select(characterId, id)
        return
      }
    }
    select(characterId, null)
    void setUI
  }, [slot, ui?.selectedKinkId, characterId, select, setUI])

  if (!slot) {
    return (
      <div className="custom-kinks-pane custom-kinks-pane-loading">
        Loading working copy…
      </div>
    )
  }

  return (
    <div className="custom-kinks-pane" data-testid="custom-kinks-pane">
      <KinkListRail characterId={characterId} />
      <KinkDetailPane characterId={characterId} kinkId={ui?.selectedKinkId ?? null} />
      <BulkActionBar characterId={characterId} surface="custom" />
      <TombstoneUndoBanner characterId={characterId} />
    </div>
  )
}

/** Derive the badge count for the Custom kinks tab (excludes tombstoned). */
export function countCustomKinks(slot: { payload: Record<string, unknown> } | undefined): number {
  if (!slot) return 0
  const ck =
    (slot.payload.custom_kinks as Record<string, Record<string, unknown>> | undefined) ?? {}
  let n = 0
  for (const v of Object.values(ck)) {
    if (v && v._deleted !== true) n++
  }
  return n
}
