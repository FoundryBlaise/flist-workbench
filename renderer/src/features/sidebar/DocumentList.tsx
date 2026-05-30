import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../../state'
import type { Document } from '../../lib/api'
import { EmptyState } from '../../components/EmptyState'

function relativeTime(epoch: number): string {
  const seconds = Math.max(0, Date.now() / 1000 - epoch)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(epoch * 1000).toLocaleDateString()
}

function docDisplayName(doc: Document): string {
  return doc.scratch ? 'Scratch' : doc.name
}

export function DocumentList() {
  const documents = useStore((s) => s.documents)
  const status = useStore((s) => s.documentsStatus)
  const activeDocId = useStore((s) => s.activeDocId)
  const editorDirty = useStore((s) => s.editorDirty)
  const openDocument = useStore((s) => s.openDocument)
  const createDocument = useStore((s) => s.createDocument)
  const duplicateActiveDocument = useStore((s) => s.duplicateActiveDocument)
  const renameDocument = useStore((s) => s.renameDocument)
  const deleteDocument = useStore((s) => s.deleteDocument)
  const setEditorContent = useStore((s) => s.setEditorContent)
  const [filter, setFilter] = useState('')
  const [pasteError, setPasteError] = useState<string | null>(null)

  const visible = useMemo(() => {
    if (!filter.trim()) return documents
    const q = filter.toLowerCase()
    return documents.filter((d) => docDisplayName(d).toLowerCase().includes(q))
  }, [documents, filter])

  const handleSwitch = (doc: Document) => {
    if (doc.id === activeDocId) return
    if (editorDirty) {
      const ok = window.confirm(
        `You have unsaved edits. Open "${docDisplayName(doc)}" anyway? Your draft is autosaved and will be there when you come back.`
      )
      if (!ok) return
    }
    void openDocument(doc.id)
  }

  const handleNew = () => {
    const name = window.prompt('Name the new document:', 'Untitled')
    if (!name || !name.trim()) return
    void createDocument(name.trim())
  }

  // First-run friendly shortcut: read clipboard, make a new doc, drop
  // the clipboard text into the editor. Most onboarding users already
  // have BBCode in hand from F-Chat / Frolic / a forum — pasting it in
  // is the fastest way to feel productive.
  const handlePasteNew = async () => {
    setPasteError(null)
    if (!navigator.clipboard?.readText) {
      setPasteError("Clipboard access isn't available in this environment.")
      return
    }
    let text: string
    try {
      text = await navigator.clipboard.readText()
    } catch {
      setPasteError(
        'Could not read clipboard. Try copying again, or use "+ New blank doc".'
      )
      return
    }
    if (!text.trim()) {
      setPasteError('Clipboard is empty.')
      return
    }
    const name = window.prompt('Name the new document:', 'Pasted')
    if (!name || !name.trim()) return
    await createDocument(name.trim())
    setEditorContent(text)
  }

  const handleDuplicate = () => {
    const active = documents.find((d) => d.id === activeDocId)
    if (!active) return
    const name = window.prompt(
      `Duplicate "${docDisplayName(active)}" as:`,
      `${docDisplayName(active)} copy`
    )
    if (!name || !name.trim()) return
    void duplicateActiveDocument(name.trim())
  }

  const handleRename = (doc: Document) => {
    if (doc.scratch) return
    const name = window.prompt('Rename to:', doc.name)
    if (!name || !name.trim() || name.trim() === doc.name) return
    void renameDocument(doc.id, name.trim())
  }

  const handleDelete = (doc: Document) => {
    if (doc.scratch) return
    const ok = window.confirm(
      `Delete "${doc.name}" and all of its revision history? This cannot be undone.`
    )
    if (!ok) return
    void deleteDocument(doc.id)
  }

  if (status === 'loading' || status === 'idle') {
    return <div className="sb-empty">Loading documents…</div>
  }
  if (status === 'error') {
    return <div className="sb-empty">Couldn't load documents.</div>
  }

  return (
    <div className="sb-doc-wrap">
      <div className="sb-doc-toolbar">
        <button
          type="button"
          className="sb-doc-action"
          onClick={handleNew}
          title="Create a new empty document"
        >
          + New
        </button>
        <button
          type="button"
          className="sb-doc-action"
          onClick={handleDuplicate}
          disabled={activeDocId === null}
          title="Duplicate the active document"
        >
          Duplicate
        </button>
      </div>
      {documents.length > 8 && (
        <input
          type="search"
          className="sb-doc-search"
          placeholder="Filter…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter documents"
        />
      )}
      {documents.every((d) => d.scratch) && (
        <EmptyState
          variant="inline"
          testId="documents-empty-state"
          body={
            <p>
              Documents are saved BBCode snippets — character descriptions,
              scene drafts, kink statements.
            </p>
          }
          primaryCta={{
            label: '+ New blank doc',
            onClick: handleNew,
            testId: 'documents-empty-new'
          }}
          secondaryCta={{
            label: 'Paste BBCode from clipboard',
            onClick: () => void handlePasteNew(),
            testId: 'documents-empty-paste'
          }}
          footer={
            pasteError ? (
              <div className="empty-state-error" role="alert">
                {pasteError}
              </div>
            ) : undefined
          }
        />
      )}
      <ul className="sb-list sb-list-docs" data-testid="document-list">
        {visible.map((doc) => {
          const isActive = doc.id === activeDocId
          const subtitle = doc.has_draft
            ? `draft · ${doc.latest_char_count?.toLocaleString() ?? 0} chars saved`
            : doc.latest_created_at
              ? `saved ${relativeTime(doc.latest_created_at)}`
              : 'never saved'
          return (
            <li key={doc.id} className={isActive ? 'sb-doc-item active' : 'sb-doc-item'}>
              <button
                type="button"
                className="sb-item sb-doc-button"
                onClick={() => handleSwitch(doc)}
                title={doc.name}
              >
                <span className="ic" aria-hidden>{doc.scratch ? '✱' : '·'}</span>
                <span className="label">
                  {isActive && editorDirty && <span className="sb-doc-dot">● </span>}
                  {docDisplayName(doc)}
                </span>
                <span className="meta sb-doc-meta">{subtitle}</span>
              </button>
              {!doc.scratch && (
                <div className="sb-doc-actions">
                  <button
                    type="button"
                    onClick={() => handleRename(doc)}
                    title="Rename"
                    aria-label="Rename"
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(doc)}
                    title="Delete"
                    aria-label="Delete"
                  >
                    ✕
                  </button>
                </div>
              )}
            </li>
          )
        })}
        {visible.length === 0 && (
          <li className="sb-empty-inline">No documents match "{filter}".</li>
        )}
      </ul>
    </div>
  )
}

export function useEnsureDocumentsLoaded() {
  const status = useStore((s) => s.documentsStatus)
  const load = useStore((s) => s.loadDocuments)
  useEffect(() => {
    if (status === 'idle') void load()
  }, [status, load])
}
