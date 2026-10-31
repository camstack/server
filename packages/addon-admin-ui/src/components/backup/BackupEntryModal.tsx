/**
 * BackupEntryModal — create / edit a backup ENTRY (`BackupSchedule`).
 *
 * An entry is the N:M unit: one cron cadence + retention that fans out
 * to a SET of `backups` storage locations. The location multiselect is
 * sourced from `backup.listDestinations` (the locations configured on
 * the Storage page) — this modal never creates a location.
 *
 * Shell: `ItemFormDialog`. Open state lives in the URL via
 * `useItemFormUrl` on the Backup page (`?new=1` / `?edit=<entryId>`).
 */

import {
  Button,
  FormField,
  Input,
  ItemFormDialog,
  useBackupListDestinations,
  useBackupUpsertSchedule,
  Checkbox,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { CalendarClock, Loader2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { DataStoreDatabase } from '@camstack/types'
import { BackupDatabasePicker } from './BackupDatabasePicker'
import { databasesPayload, DEFAULT_DATABASE_SELECTION, selectionOfRow } from './backup-databases'
import type { EntryRow } from './BackupEntriesTable'
import { CronEditor } from './CronEditor'
import { useTranslation } from 'react-i18next'

const QUERY_KEY_SCHEDULES = [['backup', 'listSchedules']] as const

interface DestinationBrief {
  readonly id: string
  readonly displayName: string
  readonly kind: string
}

export interface BackupEntryModalProps {
  /** The entry to edit, or null to create a new one. */
  readonly entry: EntryRow | null
  readonly onClose: () => void
  readonly onSaved: () => void
}

export function BackupEntryModal({ entry, onClose, onSaved }: BackupEntryModalProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const destData = useBackupListDestinations()
  const destinations = (destData.data ?? []) as readonly DestinationBrief[]

  const [label, setLabel] = useState<string>(entry?.label ?? '')
  const [cron, setCron] = useState<string>(entry?.cron ?? '0 3 * * *')
  const [enabled, setEnabled] = useState<boolean>(entry?.enabled ?? true)
  const [retention, setRetention] = useState<string>(String(entry?.retentionCount ?? 7))
  const [selected, setSelected] = useState<Set<string>>(new Set(entry?.locationIds ?? []))

  // A new entry carries the minimum; an existing row without a list shows as settings.
  const [databases, setDatabases] = useState<ReadonlySet<DataStoreDatabase>>(
    new Set(entry === null ? DEFAULT_DATABASE_SELECTION : selectionOfRow(entry.databases)),
  )

  const save = useBackupUpsertSchedule({
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY_SCHEDULES })
      onSaved()
    },
  })

  const toggleLocation = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const retentionNum = Number.parseInt(retention, 10)
  const canSave = useMemo(
    () =>
      label.trim().length > 0 &&
      selected.size > 0 &&
      databases.size > 0 &&
      !Number.isNaN(retentionNum) &&
      retentionNum >= 1 &&
      retentionNum <= 1000,
    [label, selected, databases, retentionNum],
  )

  const handleSave = (): void => {
    if (!canSave) return
    save.mutate({
      ...(entry ? { id: entry.id } : {}),
      label: label.trim(),
      cron: cron.trim(),
      enabled,
      locationIds: Array.from(selected),
      retentionCount: retentionNum,
      databases: [...databasesPayload(databases)],
    })
  }

  const saveError = save.error instanceof Error ? save.error.message : null

  return (
    <ItemFormDialog
      open
      onClose={onClose}
      title={
        entry
          ? t('backup.backupEntryModal.editBackupEntry', 'Edit backup entry')
          : t('backup.backupEntryModal.newBackupEntry', 'New backup entry')
      }
      icon={CalendarClock}
      error={saveError}
      width="lg"
      testId="backup-entry-form"
      footer={
        <Button size="sm" type="button" onClick={handleSave} disabled={!canSave || save.isPending}>
          {save.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {entry
            ? t('common.save', 'Save')
            : t('backup.backupEntryModal.createEntry', 'Create entry')}
        </Button>
      }
    >
      <div className="space-y-4">
        <FormField label={t('backup.backupEntryModal.name', 'Name')} required>
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t('backup.backupEntryModal.nightlyOffsite', 'Nightly offsite')}
            autoFocus
            data-testid="backup-entry-name"
          />
        </FormField>

        <FormField
          label={t('backup.backupEntryModal.locationsSelected', 'Locations ({{value1}} selected)', {
            value1: String(selected.size),
          })}
          required
        >
          {destData.isLoading && (
            <div className="flex items-center gap-2 px-1 py-2 text-xs text-foreground-subtle">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('backup.backupEntryModal.loadingLocations', 'Loading locations…')}
            </div>
          )}
          {!destData.isLoading && destinations.length === 0 && (
            <div className="rounded border border-border bg-background px-3 py-2 text-xs text-foreground-subtle italic">
              {t(
                'backup.backupEntryModal.noBackupsStorageLocationsConfigured',
                'No `backups` storage locations configured. Add one in Settings → Storage first.',
              )}
            </div>
          )}
          {destinations.length > 0 && (
            <div className="max-h-52 divide-y divide-border overflow-y-auto rounded border border-border bg-background">
              {destinations.map((d) => (
                <label
                  key={d.id}
                  className="flex cursor-pointer items-center justify-between px-3 py-2 text-xs hover:bg-primary/5"
                >
                  <div className="flex items-center gap-2">
                    <Checkbox
                      checked={selected.has(d.id)}
                      onChange={() => toggleLocation(d.id)}
                      className="accent-primary"
                    />
                    <span className="text-foreground">{d.displayName}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="rounded border border-border bg-surface px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-foreground-subtle">
                      {d.kind}
                    </span>
                    <span className="font-mono text-[10px] text-foreground-subtle">{d.id}</span>
                  </div>
                </label>
              ))}
            </div>
          )}
        </FormField>

        <BackupDatabasePicker
          selected={databases}
          onChange={setDatabases}
          disabled={save.isPending}
          testId="backup-entry-databases"
        />

        <div className="grid grid-cols-2 gap-3">
          <FormField
            label={t('backup.backupEntryModal.retentionArchivesKept', 'Retention (archives kept)')}
            required
          >
            <Input
              type="number"
              min={1}
              max={1000}
              value={retention}
              onChange={(e) => setRetention(e.target.value)}
              data-testid="backup-entry-retention"
            />
          </FormField>
          <FormField
            label={t('backup.backupEntryModal.enabled', 'Enabled')}
            description={t(
              'backup.backupEntryModal.runOnScheduleWhenChecked',
              'Run on schedule when checked.',
            )}
          >
            <label className="inline-flex cursor-pointer items-center gap-2 py-1.5 text-xs text-foreground">
              <Checkbox
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                className="accent-primary"
                data-testid="backup-entry-enabled"
              />
              <span>{t('backup.backupEntryModal.runOnSchedule', 'Run on schedule')}</span>
            </label>
          </FormField>
        </div>

        <FormField label={t('backup.backupEntryModal.schedule', 'Schedule')}>
          <CronEditor value={cron} onChange={setCron} disabled={save.isPending} />
        </FormField>
      </div>
    </ItemFormDialog>
  )
}
