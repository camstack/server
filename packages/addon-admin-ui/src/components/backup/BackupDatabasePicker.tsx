/**
 * BackupDatabasePicker — "What to back up": a multi-select of the database
 * files a hub can carry, shared by the schedule editor and the "Back up now"
 * dialog. A database that does not exist on this hub yet is shown disabled
 * with a hint, never hidden; one the owner could not be asked about stays
 * selectable (unknown is not absent).
 */

import type { DataStoreDatabase } from '@camstack/types'
import { Checkbox, FormField, useBackupListAvailableDatabases } from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'
import {
  type AvailableDatabases,
  BACKUP_DATABASE_IDS,
  databaseDescription,
  databaseLabel,
  databasePresence,
  isDatabaseDisabled,
  isSnapshotsOnly,
  notCreatedHint,
  orderedSelection,
  toggleDatabase,
} from './backup-databases'

export interface BackupDatabasePickerProps {
  readonly selected: ReadonlySet<DataStoreDatabase>
  readonly onChange: (next: ReadonlySet<DataStoreDatabase>) => void
  readonly disabled?: boolean
  readonly testId?: string
}

export function BackupDatabasePicker({
  selected,
  onChange,
  disabled = false,
  testId = 'backup-databases',
}: BackupDatabasePickerProps) {
  const { t } = useTranslation()
  const query = useBackupListAvailableDatabases()
  const available: AvailableDatabases | undefined = query.data
  const snapshotsOnly = selected.size > 0 && isSnapshotsOnly(orderedSelection(selected))
  const hint =
    selected.size === 0
      ? 'Pick at least one.'
      : snapshotsOnly
        ? 'Snapshots only: configuration and files are not part of this backup.'
        : null

  return (
    <FormField
      label={t('backup.backupDatabasePicker.whatToBackUp', 'What to back up')}
      required
      {...(hint !== null ? { description: hint } : {})}
    >
      <div
        className="divide-y divide-border rounded border border-border bg-background"
        data-testid={testId}
      >
        {BACKUP_DATABASE_IDS.map((id) => {
          const presence = databasePresence(id, available)
          const rowDisabled = disabled || isDatabaseDisabled(id, available, selected)
          return (
            <label
              key={id}
              className={`flex items-start gap-2 px-3 py-2 text-xs ${rowDisabled ? 'opacity-60' : 'cursor-pointer hover:bg-primary/5'}`}
            >
              <Checkbox
                checked={selected.has(id)}
                disabled={rowDisabled}
                onChange={() => onChange(toggleDatabase(selected, id))}
                data-testid={`${testId}-${id}`}
              />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-1.5 text-foreground">
                  {databaseLabel(id)}
                </span>
                <span className="block text-[11px] text-foreground-subtle">
                  {presence === 'absent' ? notCreatedHint() : databaseDescription(id)}
                </span>
              </span>
            </label>
          )
        })}
      </div>
    </FormField>
  )
}
