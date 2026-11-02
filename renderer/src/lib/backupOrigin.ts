import type { FlistZipBackupEntry } from './api'

const SOURCE_LABEL: Record<'live' | 'workbench', string> = {
  live: 'Live',
  workbench: 'Workbench'
}

const OCCASION_LABEL: Record<NonNullable<FlistZipBackupEntry['occasion']>, string> = {
  manual: 'manual',
  'backup-all': 'Back up all',
  'before-upload': 'before Upload',
  'before-restore': 'before Restore',
  migration: 'migration'
}

/** What a Backup holds and why it was made, e.g. "Live · Back up all".
 *  Backups from before the app recorded that say "Source unknown". */
export function formatBackupOrigin(
  b: Pick<FlistZipBackupEntry, 'source' | 'occasion'>
): string {
  if (b.source !== 'live' && b.source !== 'workbench') return 'Source unknown'
  const source = SOURCE_LABEL[b.source]
  return b.occasion ? `${source} · ${OCCASION_LABEL[b.occasion]}` : source
}
