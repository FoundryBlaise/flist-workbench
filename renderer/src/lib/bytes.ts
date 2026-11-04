// How the window says a file or folder size: B, then KB, then MB with one
// decimal, in steps of 1024. The image tab keeps its own decimal
// formatter (`features/flist/imageUsage.ts`), because F-list's upload
// limit is 2,000,000 bytes and has to read as "2.0 MB" there.

const KB = 1024
export const MB = 1024 * KB

export function formatBytes(bytes: number): string {
  if (bytes < KB) return `${bytes} B`
  if (bytes < MB) return `${(bytes / KB).toFixed(0)} KB`
  return `${(bytes / MB).toFixed(1)} MB`
}
