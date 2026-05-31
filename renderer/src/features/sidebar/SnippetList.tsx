import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../../state'
import type { Document, Folder } from '../../lib/api'

const SNIPPET_DRAG_MIME = 'application/x-snippet-id'

const HELP_TEXT =
  'Snippets are reusable BBCode blocks — greetings, profile fragments, OOC disclaimers. ' +
  'Render them on the right and copy what you need into F-list.'

// Sandboxed Electron blocks window.prompt (silently returns null), so
// every "name this thing" flow uses an inline-edit input rendered
// directly in the sidebar. One slot at a time — clicking another
// surface commits/cancels the previous edit.
type EditTarget =
  | { kind: 'new-snippet'; folderId: number | null }
  | { kind: 'new-folder' }
  | { kind: 'rename-snippet'; id: number; initial: string }
  | { kind: 'rename-folder'; id: number; initial: string }

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
  const [filter, setFilter] = useState('')
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>({})
  const [rootDropOver, setRootDropOver] = useState(false)
  const [edit, setEdit] = useState<EditTarget | null>(null)
  const [editValue, setEditValue] = useState('')

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

  const startEdit = (target: EditTarget, initial: string) => {
    setEdit(target)
    setEditValue(initial)
  }
  const cancelEdit = () => setEdit(null)

  const commitEdit = async () => {
    const target = edit
    if (!target) return
    const v = editValue.trim()
    setEdit(null)
    if (!v) return
    try {
      if (target.kind === 'new-snippet') {
        await createDocument(v, target.folderId)
      } else if (target.kind === 'new-folder') {
        await createFolder(v)
      } else if (target.kind === 'rename-snippet') {
        if (v !== target.initial) await renameDocument(target.id, v)
      } else if (target.kind === 'rename-folder') {
        if (v !== target.initial) await renameFolder(target.id, v)
      }
    } catch (err) {
      console.error('[SnippetList] edit failed:', err)
    }
  }

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

  const handleDeleteSnippet = (doc: Document) => {
    if (doc.scratch) return
    const ok = window.confirm(
      `Delete "${doc.name}" and all of its revision history? This cannot be undone.`
    )
    if (!ok) return
    void deleteDocument(doc.id)
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
    if (doc.scratch && folderId !== null) return
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
  const editingNewSnippetRoot =
    edit?.kind === 'new-snippet' && edit.folderId === null
  const editingNewFolder = edit?.kind === 'new-folder'

  return (
    <div className="sb-doc-wrap">
      <div className="sb-doc-toolbar">
        <button
          type="button"
          className="sb-doc-action"
          onClick={() => startEdit({ kind: 'new-snippet', folderId: null }, '')}
          title="Create a new snippet at the top level"
        >
          + Snippet
        </button>
        <button
          type="button"
          className="sb-doc-action"
          onClick={() => startEdit({ kind: 'new-folder' }, '')}
          title="Create a new folder"
        >
          + Folder
        </button>
        <span
          className="sb-doc-help"
          tabIndex={0}
          role="img"
          aria-label="About snippets"
          title={HELP_TEXT}
        >
          (?)
        </span>
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
        {editingNewFolder && (
          <li className="sb-folder sb-folder-editing">
            <InlineEdit
              value={editValue}
              placeholder="Folder name"
              onChange={setEditValue}
              onCommit={commitEdit}
              onCancel={cancelEdit}
            />
          </li>
        )}
        {folders.map((folder) => {
          const inside = snippetsByFolder[folder.id] ?? []
          const isCollapsed = !!collapsed[folder.id]
          const renamingThisFolder =
            edit?.kind === 'rename-folder' && edit.id === folder.id
          const newSnippetInThisFolder =
            edit?.kind === 'new-snippet' && edit.folderId === folder.id
          return (
            <FolderRow
              key={folder.id}
              folder={folder}
              snippets={inside}
              isCollapsed={isCollapsed}
              activeDocId={activeDocId}
              editorDirty={editorDirty}
              renaming={renamingThisFolder}
              renameValue={editValue}
              renamingSnippetId={
                edit?.kind === 'rename-snippet' ? edit.id : null
              }
              newSnippetInline={newSnippetInThisFolder}
              editValue={editValue}
              onEditValueChange={setEditValue}
              onCommit={commitEdit}
              onCancel={cancelEdit}
              onToggle={() =>
                setCollapsed((c) => ({ ...c, [folder.id]: !isCollapsed }))
              }
              onAddSnippet={() =>
                startEdit(
                  { kind: 'new-snippet', folderId: folder.id },
                  ''
                )
              }
              onRenameFolder={() =>
                startEdit(
                  { kind: 'rename-folder', id: folder.id, initial: folder.name },
                  folder.name
                )
              }
              onDeleteFolder={() => handleDeleteFolder(folder)}
              onPickSnippet={handleSwitch}
              onRenameSnippet={(d) =>
                startEdit(
                  { kind: 'rename-snippet', id: d.id, initial: d.name },
                  d.name
                )
              }
              onDeleteSnippet={handleDeleteSnippet}
              onDropSnippet={dropToFolder(folder.id)}
            />
          )
        })}
        {editingNewSnippetRoot && (
          <li className="sb-doc-item sb-doc-item-editing">
            <InlineEdit
              value={editValue}
              placeholder="Snippet name"
              onChange={setEditValue}
              onCommit={commitEdit}
              onCancel={cancelEdit}
            />
          </li>
        )}
        {rootSnippets.map((doc) => {
          const isRenaming =
            edit?.kind === 'rename-snippet' && edit.id === doc.id
          return (
            <SnippetRow
              key={doc.id}
              doc={doc}
              active={doc.id === activeDocId}
              editorDirty={editorDirty}
              renaming={isRenaming}
              renameValue={editValue}
              onRenameChange={setEditValue}
              onRenameCommit={commitEdit}
              onRenameCancel={cancelEdit}
              onPick={() => handleSwitch(doc)}
              onRename={() =>
                startEdit(
                  { kind: 'rename-snippet', id: doc.id, initial: doc.name },
                  doc.name
                )
              }
              onDelete={() => handleDeleteSnippet(doc)}
            />
          )
        })}
        {filterLower && rootSnippets.length === 0 &&
          folders.every((f) => (snippetsByFolder[f.id]?.length ?? 0) === 0) && (
          <li className="sb-empty-inline">No snippets match "{filter}".</li>
        )}
      </ul>
    </div>
  )
}

function InlineEdit({
  value,
  placeholder,
  onChange,
  onCommit,
  onCancel
}: {
  value: string
  placeholder: string
  onChange: (next: string) => void
  onCommit: () => void
  onCancel: () => void
}) {
  const ref = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  return (
    <input
      ref={ref}
      className="sb-inline-edit"
      type="text"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          onCommit()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          onCancel()
        }
      }}
      onBlur={onCommit}
    />
  )
}

function FolderRow({
  folder,
  snippets,
  isCollapsed,
  activeDocId,
  editorDirty,
  renaming,
  renameValue,
  renamingSnippetId,
  newSnippetInline,
  editValue,
  onEditValueChange,
  onCommit,
  onCancel,
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
  renaming: boolean
  renameValue: string
  renamingSnippetId: number | null
  newSnippetInline: boolean
  editValue: string
  onEditValueChange: (next: string) => void
  onCommit: () => void
  onCancel: () => void
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
  const expanded = !isCollapsed || newSnippetInline || renaming
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
        {renaming ? (
          <div className="sb-folder-toggle sb-folder-toggle-editing">
            <span className="sb-folder-chev" aria-hidden>▾</span>
            <span className="sb-folder-ic" aria-hidden>📁</span>
            <InlineEdit
              value={renameValue}
              placeholder="Folder name"
              onChange={onEditValueChange}
              onCommit={onCommit}
              onCancel={onCancel}
            />
          </div>
        ) : (
          <button
            type="button"
            className="sb-folder-toggle"
            onClick={onToggle}
            aria-expanded={!isCollapsed}
            title={isCollapsed ? 'Expand folder' : 'Collapse folder'}
          >
            <span className="sb-folder-chev" aria-hidden>
              {expanded ? '▾' : '▸'}
            </span>
            <span className="sb-folder-ic" aria-hidden>📁</span>
            <span className="sb-folder-name">{folder.name}</span>
            <span className="sb-folder-count">{snippets.length}</span>
          </button>
        )}
        <div className="sb-folder-actions">
          <button type="button" onClick={onAddSnippet} title="Add snippet to this folder" aria-label="Add snippet">+</button>
          <button type="button" onClick={onRenameFolder} title="Rename folder" aria-label="Rename folder">✎</button>
          <button type="button" onClick={onDeleteFolder} title="Delete folder" aria-label="Delete folder">✕</button>
        </div>
      </div>
      {expanded && (
        <ul className="sb-folder-children">
          {newSnippetInline && (
            <li className="sb-doc-item sb-doc-item-editing">
              <InlineEdit
                value={editValue}
                placeholder="Snippet name"
                onChange={onEditValueChange}
                onCommit={onCommit}
                onCancel={onCancel}
              />
            </li>
          )}
          {snippets.map((doc) => (
            <SnippetRow
              key={doc.id}
              doc={doc}
              active={doc.id === activeDocId}
              editorDirty={editorDirty}
              renaming={renamingSnippetId === doc.id}
              renameValue={editValue}
              onRenameChange={onEditValueChange}
              onRenameCommit={onCommit}
              onRenameCancel={onCancel}
              onPick={() => onPickSnippet(doc)}
              onRename={() => onRenameSnippet(doc)}
              onDelete={() => onDeleteSnippet(doc)}
            />
          ))}
          {snippets.length === 0 && !newSnippetInline && (
            <li className="sb-folder-empty">Drop a snippet here.</li>
          )}
        </ul>
      )}
    </li>
  )
}

function SnippetRow({
  doc,
  active,
  editorDirty,
  renaming,
  renameValue,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
  onPick,
  onRename,
  onDelete
}: {
  doc: Document
  active: boolean
  editorDirty: boolean
  renaming: boolean
  renameValue: string
  onRenameChange: (next: string) => void
  onRenameCommit: () => void
  onRenameCancel: () => void
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
      className={`${active ? 'sb-doc-item active' : 'sb-doc-item'}${renaming ? ' sb-doc-item-editing' : ''}`}
      draggable={!doc.scratch && !renaming}
      onDragStart={(e) => {
        if (doc.scratch) {
          e.preventDefault()
          return
        }
        e.dataTransfer.setData(SNIPPET_DRAG_MIME, String(doc.id))
        e.dataTransfer.effectAllowed = 'move'
      }}
    >
      {renaming ? (
        <InlineEdit
          value={renameValue}
          placeholder="Snippet name"
          onChange={onRenameChange}
          onCommit={onRenameCommit}
          onCancel={onRenameCancel}
        />
      ) : (
        <>
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
        </>
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
