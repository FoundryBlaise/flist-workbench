import { EditorView } from '@codemirror/view'
import { undo, redo } from '@codemirror/commands'
import { useStore } from '../state'
import { canRedo, canUndo } from '../state/undoStack'

export type UndoAction = 'undo' | 'redo'

/** Where an undo goes, decided by the element it is aimed at:
 *
 *   - workbench the active character's Workbench undo stack: anything
 *              that is not a text control (a kink, a field's choice, an
 *              image, no focus at all), and the Workbench's own text
 *              fields, marked `data-undo="workbench"` (the description
 *              editor, its preview, captions, infotag fields). Their
 *              typing is on that stack already, a burst per pause or
 *              blur (#111), so its newest entry is the pending typing.
 *   - native   a writable text input or textarea of the window (search,
 *              filters), or a Workbench field still holding typing it
 *              has not committed (`data-undo-pending`, an infotag field
 *              before blur): Chromium's own undo on that element.
 *   - editor   any other CodeMirror or contenteditable (a Foreign
 *              profile's source): that editor's own history.
 */
type Route = 'native' | 'editor' | 'workbench'

/** The mark of a Workbench text field, whose typing goes on the
 *  Workbench undo stack. */
const WORKBENCH_FIELD = '[data-undo="workbench"]'

/** Input types that hold typed text, and so their own undo. A focused
 *  checkbox or radio is not one: Ctrl+Z there undoes the Workbench. */
const TEXT_INPUT_TYPES = new Set([
  'text',
  'search',
  'url',
  'tel',
  'email',
  'password',
  'number'
])

function routeOf(target: Element | null): Route {
  const active = target
  if (active?.closest(WORKBENCH_FIELD) && !active.closest('[data-undo-pending]')) {
    return 'workbench'
  }
  if (
    active instanceof HTMLInputElement ||
    active instanceof HTMLTextAreaElement
  ) {
    if (active instanceof HTMLTextAreaElement || TEXT_INPUT_TYPES.has(active.type)) {
      return 'native'
    }
  }
  if (
    active?.closest('.cm-editor, [contenteditable=""], [contenteditable="true"]')
  ) {
    return 'editor'
  }
  return 'workbench'
}

/** True when `target` is a text control that keeps its own undo, so
 *  Ctrl+Z there is left to it. The Workbench's own text fields are not,
 *  unless they hold typing they have not committed yet. */
export function isTextControl(target: Element | null): boolean {
  return routeOf(target) !== 'workbench'
}

/** The character whose Workbench a workbench undo applies to: the
 *  active one, while the window shows its Workbench in the F-list
 *  editor (not the Logs, a Foreign profile, Live or a browsed Backup,
 *  which are read-only; the store refuses those too). */
function workbenchTarget(): string | null {
  const s = useStore.getState()
  if (s.mode !== 'editor' || s.foreignActive || s.editorReadOnly) return null
  return s.flistActiveCharacterId
}

function editorUndo(action: UndoAction, target: Element | null): void {
  const cmEl =
    (target?.closest('.cm-editor') as HTMLElement | null) ??
    (document.querySelector('.cm-editor') as HTMLElement | null)
  if (!cmEl) return
  const view = EditorView.findFromDOM(cmEl)
  if (!view) return
  if (action === 'undo') undo(view)
  else redo(view)
}

function workbenchUndo(action: UndoAction): void {
  const characterId = workbenchTarget()
  if (!characterId) return
  const store = useStore.getState()
  if (action === 'undo') store.flistUndo(characterId)
  else store.flistRedo(characterId)
}

/**
 * The one undo/redo dispatcher: keyboard (handleUndoKeydown), Edit menu
 * and right-click menu all come through here. `target` is the element
 * the action is aimed at, the focused one unless a menu says otherwise.
 */
export function runUndoRedo(
  action: UndoAction,
  target: Element | null = document.activeElement
): void {
  switch (routeOf(target)) {
    case 'native': {
      const input = target as HTMLInputElement | HTMLTextAreaElement
      if (input.readOnly || input.disabled) return
      try {
        document.execCommand(action)
      } catch {
        // execCommand throws in headless tests; harmless.
      }
      return
    }
    case 'editor':
      editorUndo(action, target)
      return
    case 'workbench':
      workbenchUndo(action)
  }
}

/** Whether a workbench undo or redo has anything to step over right
 *  now, for the right-click menu. Null when there is no Workbench to
 *  undo in (Logs, a Foreign profile, no character). */
export function workbenchUndoState(): { undo: boolean; redo: boolean } | null {
  const characterId = workbenchTarget()
  if (!characterId) return null
  return { undo: canUndo(characterId), redo: canRedo(characterId) }
}

/** The undo key a keydown carries: Ctrl+Z undoes, Ctrl+Y and
 *  Ctrl+Shift+Z redo (Cmd on macOS). */
export function undoKeyOf(e: KeyboardEvent): UndoAction | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null
  const key = e.key.toLowerCase()
  if (key === 'z') return e.shiftKey ? 'redo' : 'undo'
  if (key === 'y' && !e.shiftKey) return 'redo'
  return null
}

/** The window's keydown handler for Ctrl+Z / Ctrl+Y. The menu leaves
 *  these keys to the focused element, so a text control with its own
 *  undo keeps handling them; everywhere else, the Workbench's own text
 *  fields included, they undo and redo the Workbench. */
export function handleUndoKeydown(e: KeyboardEvent): void {
  if (e.defaultPrevented) return
  const action = undoKeyOf(e)
  if (!action) return
  const target = e.target instanceof Element ? e.target : null
  if (isTextControl(target)) return
  e.preventDefault()
  runUndoRedo(action, target)
}
