import { useStore } from '../../state'

export function LogViewer() {
  const partner = useStore((s) => s.activePartner)
  return (
    <section className="pane" data-testid="log-viewer">
      <header className="pane-head">{partner ?? 'Pick a partner'}</header>
      <div className="pane-body pane-body-placeholder">
        {partner
          ? 'Message viewer lands once the binary log parser is ported.'
          : 'Choose a partner from the sidebar.'}
      </div>
    </section>
  )
}
