import { useEffect } from 'react'
import { useStore } from '../state'
import { subscribeToWorkbenchEvents } from '../lib/eventStream'
import { applyWorkbenchEvent } from '../state/workbenchEvents'

/** The layout's watch on the sidecar: every change this window did not
 *  make goes to the store, which re-reads what it touched (see
 *  state/workbenchEvents). Open while the layout is mounted. */
export function useWorkbenchEvents(): void {
  useEffect(() => {
    return subscribeToWorkbenchEvents((event) => applyWorkbenchEvent(event, useStore.getState()))
  }, [])
}
