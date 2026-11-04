import { useEffect, type ReactNode } from 'react'

/** How long a note about the Workbench stays before it fades. */
export const NOTE_MS = 8000

/** Fade `note` after NOTE_MS: `fade` is called with it then, unless a
 *  new note (or a new `fade`) came first, which starts the wait again.
 *  Pass a stable `fade` (a setter, or a useCallback). */
export function useFadeAfter<T>(note: T | null | undefined, fade: (note: T) => void): void {
  useEffect(() => {
    if (!note) return
    const id = window.setTimeout(() => fade(note), NOTE_MS)
    return () => window.clearTimeout(id)
  }, [note, fade])
}

/** The bar a note about the Workbench shows in, under the toolbar. */
export function FadingNote({
  className,
  testId,
  children
}: {
  className?: string
  testId: string
  children: ReactNode
}) {
  return (
    <div
      className={className ? `workbench-note ${className}` : 'workbench-note'}
      role="status"
      data-testid={testId}
    >
      {children}
    </div>
  )
}
