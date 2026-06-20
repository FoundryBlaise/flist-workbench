import { EditorView } from '@codemirror/view'
import { undo, redo } from '@codemirror/commands'

/**
 * App-wide undo/redo dispatcher used by both the Edit menu items and
 * the right-click menu. Picks the right undo stack based on what's
 * focused:
 *
 *   - Native text input / textarea → document.execCommand (Chromium's
 *     own undo stack on the input element).
 *   - Everything else (CodeMirror, preview contentEditable, no focus)
 *     → CodeMirror's history extension. The preview pane's writeback
 *     funnels through the editor view, so CM's stack is the full
 *     cross-pane timeline.
 */
export function runUndoRedo(action: 'undo' | 'redo'): void {
  const active = document.activeElement
  if (
    active instanceof HTMLInputElement ||
    active instanceof HTMLTextAreaElement
  ) {
    if (!active.readOnly && !active.disabled) {
      try {
        document.execCommand(action)
      } catch {
        // execCommand throws in headless tests; harmless.
      }
    }
    return
  }
  const cmEl = document.querySelector('.cm-editor') as HTMLElement | null
  if (!cmEl) return
  const view = EditorView.findFromDOM(cmEl)
  if (!view) return
  if (action === 'undo') undo(view)
  else redo(view)
}
