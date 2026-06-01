import { useEffect } from 'react'

const TAMPERMONKEY_URL = 'https://www.tampermonkey.net/'
const USERSCRIPT_URL =
  'https://github.com/FoundryBlaise/flistcharexporter/raw/main/flist-character-exporter.user.js'

export function UserscriptHelpModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal flist-userscript-help-modal">
        <header className="modal-head">
          <div>
            <h2 className="modal-title">Install the restore userscript</h2>
            <p className="modal-subtitle">
              Workbench can prepare a ZIP for restore but cannot directly
              edit your F-list profile. A browser userscript reads the ZIP
              and drives F-list's edit form to upload images and save the
              updated character. The script only uploads — it never
              deletes anything on F-list.
            </p>
          </div>
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </header>
        <div className="modal-body flist-userscript-help-body">
          <ol className="flist-userscript-help-steps">
            <li>
              <strong>Install a userscript manager in your browser.</strong>
              <div>
                Tampermonkey is the most widely supported.
                <a
                  href={TAMPERMONKEY_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="flist-userscript-help-link"
                >
                  Get Tampermonkey →
                </a>
              </div>
            </li>
            <li>
              <strong>Install the flistcharexporter userscript.</strong>
              <div>
                Open the link below — Tampermonkey will offer to install it.
                <a
                  href={USERSCRIPT_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="flist-userscript-help-link"
                >
                  Install flistcharexporter →
                </a>
              </div>
            </li>
            <li>
              <strong>In Workbench: pick the working set you want to restore</strong>{' '}
              and click "Export for restore" in the sidebar. You'll get a ZIP
              containing the curated character JSON, gallery images, and avatar.
            </li>
            <li>
              <strong>On F-list:</strong> go to your character's edit page.
              The userscript adds a panel for picking the ZIP. Drop it in,
              review what will change, and confirm. The userscript will
              upload missing images and save your character.
            </li>
          </ol>
          <div className="flist-userscript-help-callout">
            <strong>Safety:</strong> the userscript never deletes images
            on F-list — it can only upload. If your working set leaves out
            an image that's currently on Live, remove it manually on the
            F-list website. F-list image deletions are irreversible, so we
            never automate them.
          </div>
        </div>
        <footer className="modal-foot">
          <button
            type="button"
            className="flist-userscript-help-close"
            onClick={onClose}
          >
            Close
          </button>
        </footer>
      </div>
    </div>
  )
}
