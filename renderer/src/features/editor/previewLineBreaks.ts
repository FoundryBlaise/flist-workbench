/** Enter in the editable preview breaks the line; it never splits the
 *  paragraph.
 *
 *  BBCode has no paragraphs, only newlines in the text. Chromium's
 *  paragraph split, though, copies the source-mapped span around the
 *  caret into a new block, and both halves then claim the same source
 *  range. A line break (what Shift+Enter does) puts a <br> inside the
 *  one span, which reads back as the "\n" the user meant.
 *
 *  Returns the function that stops listening.
 */
export function enterAsLineBreak(el: HTMLElement): () => void {
  const onBeforeInput = (e: InputEvent) => {
    if (e.inputType !== 'insertParagraph') return
    e.preventDefault()
    // Fires the input event the preview's writeback listens to.
    document.execCommand('insertLineBreak')
  }
  el.addEventListener('beforeinput', onBeforeInput)
  return () => el.removeEventListener('beforeinput', onBeforeInput)
}
