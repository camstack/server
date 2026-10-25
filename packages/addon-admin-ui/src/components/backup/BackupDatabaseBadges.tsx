/**
 * The databases a schedule or an archive carries, as compact uppercase plain
 * text (`SETTINGS · EVENTS · HISTORY`). One component for the schedule table,
 * the archive list and the restore wizard.
 */
import type { DataStoreDatabase } from '@camstack/types'
import { databaseShortLabel } from './backup-databases'

export interface BackupDatabaseBadgesProps {
  readonly databases: readonly DataStoreDatabase[]
}

export function BackupDatabaseBadges({ databases }: BackupDatabaseBadgesProps) {
  return (
    <span
      className="text-xs font-medium uppercase tracking-wide text-foreground-muted"
      data-testid="backup-database-badges"
    >
      {databases.map((id) => databaseShortLabel(id)).join(' · ')}
    </span>
  )
}
