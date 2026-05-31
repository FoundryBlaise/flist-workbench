import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../../state'
import type { Document, Folder } from '../../lib/api'
import { EmptyState } from '../../components/EmptyState'

const SNIPPET_DRAG_MIME = 'application/x-snippet-id'

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

function snippetDisplayName(doc: Document): string {
  return doc.scratch ? 'Scratch' : doc.name
}

export function SnippetList() {
  const documents = useStore((s) => s.documents)
  const folders = useStore((s) => s.folders)
  const status = useStore((s) => s.documentsStatus)
  const activeDocId = useStore((s) => s.activeDocId)
  const editorDirty = useStore((s) => s.editorDirty)
  const openDocument = useStore((s) => s.openDocument)
  const createDocument = useStore((s) => s.createDocument)
  const renameDocument = useStore((s) => s.renameDocument)
  const deleteDocument = useStore((s) => s.deleteDocument)
  const moveDocument = useStore((s) => s.moveDocument)
  const createFolder = useStore((s) => s.createFolder)
  const renameFolder = useStore((s) => s.renameFolder)
  const deleteFolder = useStore((s) => s.deleteFolder)
  const setEditorContent = useStore((s) => s.setEditorContent)
  const [filter, setFilter] = useState('')
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>({})
  const [pasteError, setPasteError] = useState<string | null>(null)
  const [rootDropOver, setRootDropOver] = useState(false)

  // Filter applies across snippets only — folder names always show so
  // the tree shape stays stable while typing.
  const filterLower = filter.trim().toLowerCase()
  const filtered = useMemo(() => {
    if (!filterLower) return documents
    return documents.filter((d) =>
      snippetDisplayName(d).toLowerCase().includes(filterLower)
    )
  }, [documents, filterLower])

  const { rootSnippets, snippetsByFolder } = useMemo(() => {
    const root: Document[] = []
    const byFolder: Record<number, Document[]> = {}
    for (const d of filtered) {
      if (d.folder_id == null) root.push(d)
      else (byFolder[d.folder_id] ||= []).push(d)
    }
    return { rootSnippets: root, snippetsByFolder: byFolder }
  }, [filtered])

  const handleSwitch = (doc: Document) => {
    if (doc.id === activeDocId) return
    if (editorDirty) {
      const ok = window.confirm(
        `You have unsaved edits. Open "${snippetDisplayName(doc)}" anyway? Your draft is autosaved and will be there when you come back.`
      )
      if (!ok) return
    }
    void openDocument(doc.id)
  }

  const handleNewSnippet = (folderId: number | null) => {
    const name = window.prompt('Name the new snippet:', 'Untitled')
    if (!name || !name.trim()) return
    void createDocument(name.trim(), folderId)
  }

  const handleNewFolder = () => {
    const name = window.prompt('Name the new folder:', 'New folder')
    if (!name || !name.trim()) return
    void createFolder(name.trim())
  }

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
        'Could not read clipboard. Try copying again, or use "+ New snippet".'
      )
      return
    }
    if (!text.trim()) {
      setPasteError('Clipboard is empty.')
      return
    }
    const name = window.prompt('Name the new snippet:', 'Pasted')
    if (!name || !name.trim()) return
    await createDocument(name.trim(), null)
    setEditorContent(text)
  }

  const handleRenameSnippet = (doc: Document) => {
    if (doc.scratch) return
    const name = window.prompt('Rename to:', doc.name)
    if (!name || !name.trim() || name.trim() === doc.name) return
    void renameDocument(doc.id, name.trim())
  }

  const handleDeleteSnippet = (doc: Document) => {
    if (doc.scratch) return
    const ok = window.confirm(
      `Delete "${doc.name}" and all of its revision history? This cannot be undone.`
    )
    if (!ok) return
    void deleteDocument(doc.id)
  }

  const handleRenameFolder = (folder: Folder) => {
    const name = window.prompt('Rename folder to:', folder.name)
    if (!name || !name.trim() || name.trim() === folder.name) return
    void renameFolder(folder.id, name.trim())
  }

  const handleDeleteFolder = (folder: Folder) => {
    const inside = snippetsByFolder[folder.id]?.length ?? 0
    const message = inside
      ? `Delete folder "${folder.name}"? Its ${inside} snippet${inside === 1 ? '' : 's'} will return to the top level.`
      : `Delete folder "${folder.name}"?`
    if (!window.confirm(message)) return
    void deleteFolder(folder.id)
  }

  const dropToFolder = (folderId: number | null) => (e: React.DragEvent) => {
    e.preventDefault()
    const raw = e.dataTransfer.getData(SNIPPET_DRAG_MIME)
    if (!raw) return
    const id = Number(raw)
    if (!Number.isFinite(id)) return
    const doc = documents.find((d) => d.id === id)
    if (!doc) return
    if (doc.scratch && folderId !== null) return // Scratch sticks to root
    if ((doc.folder_id ?? null) === folderId) return
    void moveDocument(id, folderId)
  }

  if (status === 'loading' || status === 'idle') {
    return <div className="sb-empty">Loading snippets…</div>
  }
  if (status === 'error') {
    return <div className="sb-empty">Couldn't load snippets.</div>
  }

  const tooFew = documents.length <= 8 && folders.length === 0

  return (
    <div className="sb-doc-wrap">
      <div className="sb-doc-toolbar">
        <button
          type="button"
          className="sb-doc-action"
          onClick={() => handleNewSnippet(null)}
          title="Create a new empty snippet at the top level"
        >
          + Snippet
        </button>
        <button
          type="button"
          className="sb-doc-action"
          onClick={handleNewFolder}
          title="Create a new folder"
        >
          + Folder
        </button>
      </div>
      {!tooFew && (
        <input
          type="search"
          className="sb-doc-search"
          placeholder="Filter snippets…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter snippets"
        />
      )}
      {documents.every((d) => d.scratch) && folders.length === 0 && (
        <EmptyState
          variant="inline"
          testId="snippets-empty-state"
          body={
            <p>
              Snippets are reusable BBCode blocks — greetings, profile
              fragments, OOC disclaimers. Render them on the right and
              copy what you need into F-list.
            </p>
          }
          primaryCta={{
            label: '+ New blank snippet',
            onClick: () => handleNewSnippet(null),
            testId: 'snippets-empty-new'
          }}
          secondaryCta={{
            label: 'Paste BBCode from clipboard',
            onClick: () => void handlePasteNew(),
            testId: 'snippets-empty-paste'
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
      <ul
        className={`sb-list sb-list-docs${rootDropOver ? ' sb-list-drop-over' : ''}`}
        data-testid="snippet-list"
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(SNIPPET_DRAG_MIME)) return
          e.preventDefault()
          setRootDropOver(true)
        }}
        onDragLeave={() => setRootDropOver(false)}
        onDrop={(e) => {
          setRootDropOver(false)
          dropToFolder(null)(e)
        }}
      >
        {folders.map((folder) => {
          const inside = snippetsByFolder[folder.id] ?? []
          const isCollapsed = !!collapsed[folder.id]
          return (
            <FolderRow
              key={folder.id}
              folder={folder}
              snippets={inside}
              isCollapsed={isCollapsed}
              activeDocId={activeDocId}
              editorDirty={editorDirty}
              onToggle={() =>
                setCollapsed((c) => ({ ...c, [folder.id]: !isCollapsed }))
              }
              onAddSnippet={() => handleNewSnippet(folder.id)}
              onRenameFolder={() => handleRenameFolder(folder)}
              onDeleteFolder={() => handleDeleteFolder(folder)}
              onPickSnippet={handleSwitch}
              onRenameSnippet={handleRenameSnippet}
              onDeleteSnippet={handleDeleteSnippet}
              onDropSnippet={dropToFolder(folder.id)}
            />
          )
        })}
        {rootSnippets.map((doc) => (
          <SnippetRow
            key={doc.id}
            doc={doc}
            active={doc.id === activeDocId}
            editorDirty={editorDirty}
            onPick={() => handleSwitch(doc)}
            onRename={() => handleRenameSnippet(doc)}
            onDelete={() => handleDeleteSnippet(doc)}
          />
        ))}
        {filterLower && rootSnippets.length === 0 && folders.every((f) => (snippetsByFolder[f.id]?.length ?? 0) === 0) && (
          <li className="sb-empty-inline">No snippets match "{filter}".</li>
        )}
      </ul>
    </div>
  )
}

function FolderRow({
  folder,
  snippets,
  isCollapsed,
  activeDocId,
  editorDirty,
  onToggle,
  onAddSnippet,
  onRenameFolder,
  onDeleteFolder,
  onPickSnippet,
  onRenameSnippet,
  onDeleteSnippet,
  onDropSnippet
}: {
  folder: Folder
  snippets: Document[]
  isCollapsed: boolean
  activeDocId: number | null
  editorDirty: boolean
  onToggle: () => void
  onAddSnippet: () => void
  onRenameFolder: () => void
  onDeleteFolder: () => void
  onPickSnippet: (doc: Document) => void
  onRenameSnippet: (doc: Document) => void
  onDeleteSnippet: (doc: Document) => void
  onDropSnippet: (e: React.DragEvent) => void
}) {
  const [over, setOver] = useState(false)
  return (
    <li className={`sb-folder${over ? ' sb-folder-over' : ''}`}>
      <div
        className="sb-folder-row"
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(SNIPPET_DRAG_MIME)) return
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          setOver(false)
          onDropSnippet(e)
        }}
      >
        <button
          type="button"
          className="sb-folder-toggle"
          onClick={onToggle}
          aria-expanded={!isCollapsed}
          title={isCollapsed ? 'Expand folder' : 'Collapse folder'}
        >
          <span className="sb-folder-chev" aria-hidden>
            {isCollapsed ? '▸' : '▾'}
          </span>
          <span className="sb-folder-ic" aria-hidden>📁</span>
          <span className="sb-folder-name">{folder.name}</span>
          <span className="sb-folder-count">{snippets.length}</span>
        </button>
        <div className="sb-folder-actions">
          <button type="button" onClick={onAddSnippet} title="Add snippet to this folder" aria-label="Add snippet">+</button>
          <button type="button" onClick={onRenameFolder} title="Rename folder" aria-label="Rename folder">✎</button>
          <button type="button" onClick={onDeleteFolder} title="Delete folder" aria-label="Delete folder">✕</button>
        </div>
      </div>
      {!isCollapsed && snippets.length > 0 && (
        <ul className="sb-folder-children">
          {snippets.map((doc) => (
            <SnippetRow
              key={doc.id}
              doc={doc}
              active={doc.id === activeDocId}
              editorDirty={editorDirty}
              onPick={() => onPickSnippet(doc)}
              onRename={() => onRenameSnippet(doc)}
              onDelete={() => onDeleteSnippet(doc)}
            />
          ))}
        </ul>
      )}
      {!isCollapsed && snippets.length === 0 && (
        <div className="sb-folder-empty">Drop a snippet here.</div>
      )}
    </li>
  )
}

function SnippetRow({
  doc,
  active,
  editorDirty,
  onPick,
  onRename,
  onDelete
}: {
  doc: Document
  active: boolean
  editorDirty: boolean
  onPick: () => void
  onRename: () => void
  onDelete: () => void
}) {
  const subtitle = doc.has_draft
    ? `draft · ${doc.latest_char_count?.toLocaleString() ?? 0} chars saved`
    : doc.latest_created_at
      ? `saved ${relativeTime(doc.latest_created_at)}`
      : 'never saved'
  return (
    <li
      className={active ? 'sb-doc-item active' : 'sb-doc-item'}
      draggable={!doc.scratch}
      onDragStart={(e) => {
        if (doc.scratch) {
          e.preventDefault()
          return
        }
        e.dataTransfer.setData(SNIPPET_DRAG_MIME, String(doc.id))
        e.dataTransfer.effectAllowed = 'move'
      }}
    >
      <button
        type="button"
        className="sb-item sb-doc-button"
        onClick={onPick}
        title={doc.name}
      >
        <span className="ic" aria-hidden>{doc.scratch ? '✱' : '·'}</span>
        <span className="label">
          {active && editorDirty && <span className="sb-doc-dot">● </span>}
          {snippetDisplayName(doc)}
        </span>
        <span className="meta sb-doc-meta">{subtitle}</span>
      </button>
      {!doc.scratch && (
        <div className="sb-doc-actions">
          <button type="button" onClick={onRename} title="Rename" aria-label="Rename">✎</button>
          <button type="button" onClick={onDelete} title="Delete" aria-label="Delete">✕</button>
        </div>
      )}
    </li>
  )
}

export function useEnsureSnippetsLoaded() {
  const status = useStore((s) => s.documentsStatus)
  const load = useStore((s) => s.loadDocuments)
  const loadFolders = useStore((s) => s.loadFolders)
  useEffect(() => {
    if (status === 'idle') {
      void load()
      void loadFolders()
    }
  }, [status, load, loadFolders])
}
