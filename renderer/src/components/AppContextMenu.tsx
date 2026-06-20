import { useEffect, useState } from 'react'
import { EditorView } from '@codemirror/view'
import { findEnclosingTag } from '../lib/bbcode/findEnclosingTag'

/**
 * Global right-click menu, replacing the previous main-process native
 * menu in electron/contextMenu.ts. Lives in the renderer so the menu
 * can be context-aware:
 *
 *   - Inside a CodeMirror editor: standard clipboard items +
 *     "Delete [tag] (keep content)" when the cursor sits inside a
 *     recognised BBCode pair.
 *   - Inside an input/textarea/contenteditable: standard clipboard
 *     items.
 *   - On a regular text selection: Copy.
 *
 * Outside those targets it stays silent (no menu, no item to show).
 */
type Item = {
  label: string
  onClick: () => void
  enabled?: boolean
}

type Anchor = { x: number; y: number; items: Item[] }

const MENU_MIN_PADDING = 8

export function AppContextMenu() {
  const [anchor, setAnchor] = useState<Anchor | null>(null)

  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      const items = buildItems(e)
      if (!items.length) return
      e.preventDefault()
      const pos = clampToViewport(e.clientX, e.clientY, items.length)
      setAnchor({ x: pos.x, y: pos.y, items })
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAnchor(null)
    }
    const onMouseDown = (e: MouseEvent) => {
      const t = e.target as Element | null
      if (!t?.closest('.app-ctx-menu')) setAnchor(null)
    }
    const onResize = () => setAnchor(null)
    document.addEventListener('contextmenu', onCtx)
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onMouseDown, true)
    window.addEventListener('resize', onResize)
    window.addEventListener('blur', onResize)
    return () => {
      document.removeEventListener('contextmenu', onCtx)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onMouseDown, true)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('blur', onResize)
    }
  }, [])

  if (!anchor) return null

  return (
    <div
      className="app-ctx-menu"
      style={{ left: anchor.x, top: anchor.y }}
      role="menu"
    >
      {anchor.items.map((item, i) => (
        <button
          key={i}
          type="button"
          role="menuitem"
          className="app-ctx-menu-item"
          disabled={item.enabled === false}
          onClick={() => {
            if (item.enabled === false) return
            try {
              item.onClick()
            } finally {
              setAnchor(null)
            }
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

function clampToViewport(
  x: number,
  y: number,
  itemCount: number
): { x: number; y: number } {
  // Rough estimate; menu auto-sizes but we know roughly its bounds. We
  // adjust if the menu would otherwise spill off the right/bottom.
  const estW = 220
  const estH = 28 * itemCount + 12
  const maxX = window.innerWidth - estW - MENU_MIN_PADDING
  const maxY = window.innerHeight - estH - MENU_MIN_PADDING
  return {
    x: Math.max(MENU_MIN_PADDING, Math.min(x, maxX)),
    y: Math.max(MENU_MIN_PADDING, Math.min(y, maxY))
  }
}

function buildItems(e: MouseEvent): Item[] {
  const target = e.target as Element | null
  if (!target) return []

  const cmEditor = target.closest('.cm-editor') as HTMLElement | null
  if (cmEditor) return buildEditorItems(cmEditor, e.clientX, e.clientY)

  const input = target.closest(
    'input, textarea, [contenteditable=""], [contenteditable="true"]'
  ) as HTMLElement | null
  if (input) return buildInputItems(input)

  const sel = window.getSelection()
  if (sel && !sel.isCollapsed && sel.toString().length > 0) {
    return [{ label: 'Copy', onClick: () => document.execCommand('copy') }]
  }

  return []
}

function buildEditorItems(
  editorEl: HTMLElement,
  clickX: number,
  clickY: number
): Item[] {
  const view = EditorView.findFromDOM(editorEl)
  if (!view) return []
  const isEditable = view.state.facet(EditorView.editable)
  const hasSelection = !view.state.selection.main.empty
  const items: Item[] = [
    {
      label: 'Cut',
      enabled: isEditable && hasSelection,
      onClick: () => runCmCommand(view, 'cut')
    },
    {
      label: 'Copy',
      enabled: hasSelection,
      onClick: () => runCmCommand(view, 'copy')
    },
    {
      label: 'Paste',
      enabled: isEditable,
      onClick: () => runCmCommand(view, 'paste')
    },
    {
      label: 'Select all',
      onClick: () => {
        view.dispatch({
          selection: { anchor: 0, head: view.state.doc.length }
        })
        view.focus()
      }
    }
  ]

  // Use the click coords to pick the tag — the user may not have
  // moved the caret. Fall back to the caret if posAtCoords misses
  // (clicks in the empty space below the last line, etc.).
  const docPos =
    view.posAtCoords({ x: clickX, y: clickY }) ?? view.state.selection.main.head
  const source = view.state.doc.toString()
  const tag = findEnclosingTag(source, docPos)
  if (tag) {
    items.push({
      label: `Delete [${tag.name}] (keep content)`,
      enabled: isEditable,
      onClick: () => stripTag(view, tag.openStart, tag.openEnd, tag.closeStart, tag.closeEnd)
    })
  }
  return items
}

function runCmCommand(view: EditorView, cmd: 'cut' | 'copy' | 'paste'): void {
  // CodeMirror listens for clipboard events on its content element;
  // synthesising one lets the editor handle it the same way Ctrl+X/C/V
  // would. document.execCommand is deprecated in spec but reliable in
  // Electron renderers and the simplest path that keeps CM's own
  // change-tracking + multi-cursor support intact.
  view.focus()
  try {
    document.execCommand(cmd)
  } catch {
    // execCommand throws in headless test environments; nothing useful
    // to do but swallow.
  }
}

function stripTag(
  view: EditorView,
  openStart: number,
  openEnd: number,
  closeStart: number,
  closeEnd: number
): void {
  view.dispatch({
    changes: [
      { from: closeStart, to: closeEnd },
      { from: openStart, to: openEnd }
    ]
  })
  view.focus()
}

function buildInputItems(input: HTMLElement): Item[] {
  const isTextField =
    input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement
  const readonly = isTextField
    ? input.readOnly || input.disabled
    : input.getAttribute('contenteditable') === 'false'
  const hasSelection = (() => {
    if (isTextField) {
      const start = input.selectionStart ?? 0
      const end = input.selectionEnd ?? 0
      return end > start
    }
    const sel = window.getSelection()
    return !!(sel && !sel.isCollapsed && sel.toString().length > 0)
  })()
  const focusFirst = () => {
    if (document.activeElement !== input) input.focus()
  }
  return [
    {
      label: 'Cut',
      enabled: !readonly && hasSelection,
      onClick: () => {
        focusFirst()
        document.execCommand('cut')
      }
    },
    {
      label: 'Copy',
      enabled: hasSelection,
      onClick: () => {
        focusFirst()
        document.execCommand('copy')
      }
    },
    {
      label: 'Paste',
      enabled: !readonly,
      onClick: () => {
        focusFirst()
        document.execCommand('paste')
      }
    },
    {
      label: 'Select all',
      onClick: () => {
        focusFirst()
        if (
          input instanceof HTMLInputElement ||
          input instanceof HTMLTextAreaElement
        ) {
          input.select()
        } else {
          document.execCommand('selectAll')
        }
      }
    }
  ]
}
