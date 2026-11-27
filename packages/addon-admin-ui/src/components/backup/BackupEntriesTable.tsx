/**
 * BackupEntriesTable — one row per backup ENTRY (a `BackupSchedule`).
 *
 * An entry binds one cron cadence + retention to a SET of `backups`
 * storage locations (configured in Settings → Storage). When the cron
 * fires — or the operator clicks "Run now" — a single archive is fanned
 * out to every location the entry targets, and each is pruned to the
 * entry's retention count.
 *
 * Managed list: DataTable. Create/edit opens via the page's
 * `useItemFormUrl` (`?new=1` / `?edit=<id>`). Expanding a row shows the
 * archives at each of the entry's locations below the table (DataTable
 * has no inline detail rows).
 */

import type { DataStoreDatabase } from '@camstack/types'
import {
  Button,
  type DataColumn,
  DataTable,
  EmptyState,
  ErrorBox,
  FormSaveBar,
  IconButton,
  Input,
  TABLE_SCROLL_MAX_H,
  useBackupDeleteSchedule,
  useBackupListDestinations,
  useBackupListSchedules,
  useBackupTrigger,
  useBackupUpsertSchedule,
  useConfirm,
  useIsPhone,
  Checkbox,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import {
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Loader2,
  Pencil,
  Play,
  Trash2,
} from 'lucide-react'
import { type ReactNode, useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from '../../i18n/index'
import { ArchiveList } from './ArchiveList'
import { BackupDatabaseBadges } from './BackupDatabaseBadges'
import { selectionOfRow } from './backup-databases'

const QUERY_KEY_SCHEDULES = [['backup', 'listSchedules']] as const

/** Reference passed back when opening the restore wizard from an
 *  archive drill-in row. */
export interface ArchiveRefBrief {
  readonly destinationId: string
  readonly archiveId: string
}

export interface EntryRow {
  readonly id: string
  readonly label: string
  readonly cron: string
  readonly enabled: boolean
  readonly locationIds: readonly string[]
  readonly retentionCount: number
  readonly dataSources?: readonly string[]
  /** Absent / empty = `['settings']`. */
  readonly databases?: readonly DataStoreDatabase[]
  readonly lastRunAt?: number
  readonly nextRunAt?: number
}

interface DestinationBrief {
  readonly id: string
  readonly displayName: string
  readonly restoreSupported: boolean
}

export interface BackupEntriesTableProps {
  /** Open the create/edit modal for an entry. */
  readonly onEdit: (entry: EntryRow) => void
  /** Open the restore wizard pre-filled from an archive drill-in. */
  readonly onOpenRestoreWizard?: (ref: ArchiveRefBrief) => void
}

export function BackupEntriesTable({ onEdit, onOpenRestoreWizard }: BackupEntriesTableProps) {
  const { t } = useTranslation()
  const { data, isLoading, isError, error, refetch } = useBackupListSchedules()
  const rows = (data ?? []) as readonly EntryRow[]
  const destData = useBackupListDestinations()
  const destinations = (destData.data ?? []) as readonly DestinationBrief[]
  const destById = useMemo(() => {
    const m = new Map<string, DestinationBrief>()
    for (const d of destinations) m.set(d.id, d)
    return m
  }, [destinations])

  const [expanded, setExpanded] = useState<string | null>(null)
  const toggleExpand = useCallback((id: string): void => {
    setExpanded((prev) => (prev === id ? null : id))
  }, [])

  // Enabled and retention edits of every row are ONE draft with ONE Save (planning#675).
  const queryClient = useQueryClient()
  const upsert = useBackupUpsertSchedule()
  const [draft, setDraft] = useState<Readonly<Record<string, EntryDraft>>>({})
  const [saveError, setSaveError] = useState<string | null>(null)
  const editEntry = useCallback((id: string, edit: EntryDraft): void => {
    setDraft((prev) => ({ ...prev, [id]: { ...prev[id], ...edit } }))
  }, [])
  const changes = useMemo(() => changedEntries(rows, draft), [rows, draft])
  const invalid = changes.some((c) => c.retentionCount === null)
  const discardDraft = useCallback((): void => {
    setDraft({})
    setSaveError(null)
  }, [])
  const saveDraft = useCallback((): void => {
    if (invalid || changes.length === 0) return
    setSaveError(null)
    void Promise.all(
      changes.map((c) =>
        upsert.mutateAsync({
          ...entryBasePayload(c.row),
          enabled: c.enabled,
          retentionCount: c.retentionCount ?? c.row.retentionCount,
        }),
      ),
    )
      .then(() => {
        setDraft({})
        return queryClient.invalidateQueries({ queryKey: QUERY_KEY_SCHEDULES })
      })
      .catch((err: unknown) => {
        setSaveError(err instanceof Error ? err.message : String(err))
        void queryClient.invalidateQueries({ queryKey: QUERY_KEY_SCHEDULES })
      })
  }, [changes, invalid, upsert, queryClient])

  const columns = useMemo(
    () =>
      entryColumns({
        destById,
        expandedId: expanded,
        onToggleExpand: toggleExpand,
        onEdit,
        draft,
        onDraft: editEntry,
        saving: upsert.isPending,
        onSave: saveDraft,
        onDiscard: discardDraft,
      }),
    [
      destById,
      expanded,
      toggleExpand,
      onEdit,
      draft,
      editEntry,
      upsert.isPending,
      saveDraft,
      discardDraft,
    ],
  )

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-xs text-foreground-subtle animate-pulse">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t('backup.backupEntriesTable.loadingBackupEntries', 'Loading backup entries…')}
      </div>
    )
  }

  if (isError) {
    return (
      <ErrorBox
        title={t(
          'backup.backupEntriesTable.failedToLoadBackupEntries',
          'Failed to load backup entries',
        )}
        message={
          error instanceof Error
            ? error.message
            : t('backup.backupEntriesTable.unknownError', 'Unknown error')
        }
        onRetry={() => void refetch()}
      />
    )
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={CalendarClock}
        title={t('backup.backupEntriesTable.noBackupEntriesYet', 'No backup entries yet')}
        description={t(
          'backup.backupEntriesTable.createOneToScheduleBackups',
          'Create one to schedule backups across one or more storage locations.',
        )}
      />
    )
  }

  return (
    <div className="space-y-2">
      <DataTable<EntryRow>
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        minWidthPx={980}
        maxBodyHeight={TABLE_SCROLL_MAX_H}
        emptyMessage={t('backup.backupEntriesTable.noBackupEntriesYet', 'No backup entries yet')}
        onRowClick={(row) => onEdit(row)}
        sheetOpenLabel={t('backup.backupEntriesTable.editEntry', 'Edit entry')}
        isExpanded={(row) => row.id === expanded}
        renderExpanded={(row) => (
          <EntryArchivesPanel
            row={row}
            destById={destById}
            {...(onOpenRestoreWizard ? { onOpenRestoreWizard } : {})}
          />
        )}
      />
      {saveError !== null && (
        <p role="alert" className="text-xs text-danger">
          {saveError}
        </p>
      )}
      <FormSaveBar
        pendingCount={changes.length}
        saving={upsert.isPending}
        onSave={saveDraft}
        onDiscard={discardDraft}
        {...(invalid
          ? {
              problem: t(
                'backup.backupEntriesTable.retentionInvalid',
                'Retention must be a whole number of at least 1.',
              ),
            }
          : {})}
      />
    </div>
  )
}

interface EntryDraft {
  readonly enabled?: boolean
  /** The retention as typed; parsed on Save. */
  readonly retention?: string
}

interface EntryChange {
  readonly row: EntryRow
  readonly enabled: boolean
  /** null: the typed retention is not a whole number >= 1. */
  readonly retentionCount: number | null
}

function parseRetention(text: string): number | null {
  const n = Number.parseInt(text, 10)
  return Number.isNaN(n) || n < 1 ? null : n
}

/** The rows whose draft differs from the served schedule. */
function changedEntries(
  rows: readonly EntryRow[],
  draft: Readonly<Record<string, EntryDraft>>,
): readonly EntryChange[] {
  const out: EntryChange[] = []
  for (const row of rows) {
    const edit = draft[row.id]
    if (edit === undefined) continue
    const enabled = edit.enabled ?? row.enabled
    const retentionCount =
      edit.retention === undefined ? row.retentionCount : parseRetention(edit.retention)
    if (enabled !== row.enabled || retentionCount !== row.retentionCount) {
      out.push({ row, enabled, retentionCount })
    }
  }
  return out
}

interface EntryColumnsDeps {
  readonly destById: Map<string, DestinationBrief>
  readonly expandedId: string | null
  readonly onToggleExpand: (id: string) => void
  readonly onEdit: (entry: EntryRow) => void
  readonly draft: Readonly<Record<string, EntryDraft>>
  readonly onDraft: (id: string, edit: EntryDraft) => void
  readonly saving: boolean
  /** Enter in the retention input saves the draft; Escape discards it. */
  readonly onSave: () => void
  readonly onDiscard: () => void
}

function entryColumns(deps: EntryColumnsDeps): readonly DataColumn<EntryRow>[] {
  return [
    {
      mobile: 'keep',
      key: 'expand',
      header: '',
      width: 'w-8',
      nowrap: true,
      notSortableReason: 'Expand control',
      render: (row) => {
        const isOpen = deps.expandedId === row.id
        return (
          <IconButton
            variant="ghost"
            size="sm"
            icon={isOpen ? ChevronDown : ChevronRight}
            aria-label={
              isOpen
                ? i18n.t('backup.backupEntriesTable.hideArchives', 'Hide archives')
                : i18n.t('backup.backupEntriesTable.showArchives', 'Show archives')
            }
            aria-expanded={isOpen}
            onClick={(event) => {
              event.stopPropagation()
              deps.onToggleExpand(row.id)
            }}
          />
        )
      },
    },
    {
      mobile: 'primary',
      key: 'entry',
      header: i18n.t('backup.backupEntriesTable.entry', 'Entry'),
      sortValue: (row) => row.label,
      render: (row) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium text-foreground">
            {row.label || i18n.t('backup.backupEntriesTable.unnamed', '(unnamed)')}
          </span>
          {row.lastRunAt !== undefined && (
            <span className="text-[10px] text-foreground-subtle">
              {i18n.t('backup.backupEntriesTable.lastRun', {
                when: new Date(row.lastRunAt).toLocaleString(),
              })}
            </span>
          )}
        </span>
      ),
    },
    {
      mobile: 'keep',
      key: 'enabled',
      header: i18n.t('backup.backupEntriesTable.enabled', 'Enabled'),
      width: 'w-20',
      nowrap: true,
      sortValue: (row) => (row.enabled ? 1 : 0),
      render: (row) => (
        <span onClick={(event) => event.stopPropagation()}>
          <EntryEnabledToggle
            row={row}
            checked={deps.draft[row.id]?.enabled ?? row.enabled}
            disabled={deps.saving}
            onChange={(enabled) => deps.onDraft(row.id, { enabled })}
          />
        </span>
      ),
    },
    {
      mobile: 'sheet',
      key: 'databases',
      header: i18n.t('backup.backupEntriesTable.backsUp', 'Backs up'),
      nowrap: false,
      notSortableReason: 'Database badges',
      render: (row) => <BackupDatabaseBadges databases={selectionOfRow(row.databases)} />,
    },
    {
      mobile: 'sheet',
      key: 'locations',
      header: i18n.t('backup.backupEntriesTable.locations', 'Locations'),
      nowrap: false,
      notSortableReason: 'Location chips',
      render: (row) => <EntryLocationsCell row={row} destById={deps.destById} />,
    },
    {
      mobile: 'sheet',
      key: 'retention',
      header: i18n.t('backup.backupEntriesTable.retention', 'Retention'),
      width: 'w-24',
      nowrap: true,
      sortValue: (row) => row.retentionCount,
      render: (row) => (
        <span onClick={(event) => event.stopPropagation()}>
          <EntryRetentionInput
            row={row}
            value={deps.draft[row.id]?.retention ?? String(row.retentionCount)}
            disabled={deps.saving}
            onChange={(retention) => deps.onDraft(row.id, { retention })}
            onSave={deps.onSave}
            onDiscard={deps.onDiscard}
          />
        </span>
      ),
    },
    {
      mobile: 'detail',
      key: 'schedule',
      header: i18n.t('backup.backupEntriesTable.schedule', 'Schedule'),
      width: 'w-48',
      nowrap: true,
      sortValue: (row) => row.cron,
      render: (row) => <EntryScheduleCell row={row} />,
    },
    {
      mobile: 'keep',
      key: 'actions',
      header: '',
      align: 'right',
      nowrap: true,
      notSortableReason: 'Actions',
      render: (row) => (
        <span onClick={(event) => event.stopPropagation()}>
          <EntryRowActions row={row} onEdit={() => deps.onEdit(row)} />
        </span>
      ),
    },
  ]
}

interface EntryLocationsCellProps {
  readonly row: EntryRow
  readonly destById: Map<string, DestinationBrief>
}

function EntryLocationsCell({ row, destById }: EntryLocationsCellProps): ReactNode {
  const { t } = useTranslation()
  if (row.locationIds.length === 0) {
    return (
      <span className="text-[11px] italic text-danger">
        {t('backup.backupEntriesTable.noLocations', 'No locations')}
      </span>
    )
  }
  return (
    <span className="flex flex-wrap gap-1">
      {row.locationIds.map((id) => (
        <span
          key={id}
          className="inline-flex items-center rounded border border-border bg-background px-1.5 py-0.5 text-[10px] text-foreground"
          title={id}
        >
          {destById.get(id)?.displayName ?? id}
        </span>
      ))}
    </span>
  )
}

function EntryScheduleCell({ row }: { readonly row: EntryRow }): ReactNode {
  const { t } = useTranslation()
  const hasCron = row.cron.trim().length > 0
  return (
    <span className="flex flex-row items-center gap-1.5 sm:flex-col sm:items-start sm:gap-0.5">
      <span className="inline-flex items-center gap-1">
        <CalendarClock className="h-3 w-3 text-foreground-subtle" />
        <span className="font-mono text-[11px] text-foreground">
          {hasCron ? row.cron : t('backup.backupEntriesTable.manual', 'Manual')}
        </span>
      </span>
      {hasCron && row.nextRunAt !== undefined && (
        <span className="text-[10px] text-foreground-subtle">
          {i18n.t('common.nextRun', { when: new Date(row.nextRunAt).toLocaleString() })}
        </span>
      )}
    </span>
  )
}

function entryBasePayload(row: EntryRow) {
  return {
    id: row.id,
    label: row.label,
    cron: row.cron,
    locationIds: [...row.locationIds],
    retentionCount: row.retentionCount,
    ...(row.dataSources ? { dataSources: [...row.dataSources] } : {}),
    // Kept on every save: dropping it would reset the schedule to settings.
    ...(row.databases ? { databases: [...row.databases] } : {}),
  }
}

interface EntryEnabledToggleProps {
  readonly row: EntryRow
  readonly checked: boolean
  readonly disabled: boolean
  readonly onChange: (enabled: boolean) => void
}

function EntryEnabledToggle({ row, checked, disabled, onChange }: EntryEnabledToggleProps) {
  const { t } = useTranslation()
  return (
    <label className="inline-flex cursor-pointer items-center">
      <Checkbox
        className="accent-primary"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={t('backup.backupEntriesTable.enable', 'Enable {{value1}}', {
          value1: row.label || row.id,
        })}
      />
    </label>
  )
}

interface EntryRetentionInputProps {
  readonly row: EntryRow
  readonly value: string
  readonly disabled: boolean
  readonly onChange: (retention: string) => void
  readonly onSave: () => void
  readonly onDiscard: () => void
}

function EntryRetentionInput({
  row,
  value,
  disabled,
  onChange,
  onSave,
  onDiscard,
}: EntryRetentionInputProps) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-1">
      {/* ui-check-ok: the retention is a count of archives kept, not a duration */}
      <Input
        type="number"
        min={1}
        max={1000}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSave()
          else if (e.key === 'Escape') onDiscard()
        }}
        className="w-16"
        aria-label={t('backup.backupEntriesTable.retentionFor', 'Retention for {{value1}}', {
          value1: row.label || row.id,
        })}
      />
    </div>
  )
}

interface EntryRowActionsProps {
  readonly row: EntryRow
  readonly onEdit: () => void
}

function EntryRowActions({ row, onEdit }: EntryRowActionsProps) {
  const { t } = useTranslation()
  const isPhone = useIsPhone()
  const queryClient = useQueryClient()
  const confirm = useConfirm()
  const remove = useBackupDeleteSchedule({
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY_SCHEDULES })
    },
  })
  const trigger = useBackupTrigger({
    onMutate: () => {
      void queryClient.invalidateQueries({ queryKey: [['backup', 'listRuns']] })
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [['backup', 'listArchives']] })
      void queryClient.invalidateQueries({ queryKey: [['backup', 'listDestinations']] })
      void queryClient.invalidateQueries({ queryKey: [['backup', 'listRuns']] })
    },
  })

  const runNow = (): void => {
    if (row.locationIds.length === 0) return
    trigger.mutate({
      destinations: [...row.locationIds],
      ...(row.dataSources && row.dataSources.length > 0 ? { locations: [...row.dataSources] } : {}),
      label: row.label,
      retentionCount: row.retentionCount,
      databases: [...selectionOfRow(row.databases)],
    })
  }

  const handleDelete = async (): Promise<void> => {
    const ok = await confirm({
      title: t('backup.backupEntriesTable.deleteBackupEntry', 'Delete backup entry?'),
      message: t(
        'backup.backupEntriesTable.willStopRunningExistingArchives',
        '"{{value1}}" will stop running. Existing archives are kept.',
        { value1: row.label || row.id },
      ),
      confirmLabel: t('common.delete', 'Delete'),
      variant: 'warning',
    })
    if (!ok) return
    remove.mutate({ id: row.id })
  }

  return (
    <span className="flex items-center justify-end gap-1.5">
      <Button
        size="sm"
        type="button"
        onClick={runNow}
        disabled={trigger.isPending || row.locationIds.length === 0}
        title={t('backup.backupEntriesTable.runThisEntryNow', 'Run this entry now')}
      >
        {trigger.isPending ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <Play className="h-3 w-3" />
        )}
        {isPhone ? (
          <span className="sr-only">{t('backup.backupEntriesTable.runNow', 'Run now')}</span>
        ) : (
          t('backup.backupEntriesTable.runNow', 'Run now')
        )}
      </Button>
      <IconButton
        variant="ghost"
        size="sm"
        icon={Pencil}
        aria-label={t('backup.backupEntriesTable.edit', 'Edit {{value1}}', {
          value1: row.label || row.id,
        })}
        onClick={onEdit}
      />
      <IconButton
        variant="ghost"
        size="sm"
        icon={Trash2}
        aria-label={t('backup.backupEntriesTable.delete', 'Delete {{value1}}', {
          value1: row.label || row.id,
        })}
        disabled={remove.isPending}
        onClick={() => {
          void handleDelete()
        }}
      />
    </span>
  )
}

interface EntryArchivesPanelProps {
  readonly row: EntryRow
  readonly destById: Map<string, DestinationBrief>
  readonly onOpenRestoreWizard?: (ref: ArchiveRefBrief) => void
}

function EntryArchivesPanel({
  row,
  destById,
  onOpenRestoreWizard,
}: EntryArchivesPanelProps): ReactNode {
  const { t } = useTranslation()
  return (
    <div className="space-y-4 rounded-lg border border-border bg-background/30 px-4 py-3">
      <p className="text-[11px] font-medium text-foreground-subtle">
        {t('backup.backupEntriesTable.archivesFor', { name: row.label || row.id })}
      </p>
      {row.locationIds.length === 0 && (
        <p className="text-xs italic text-foreground-subtle">
          {t(
            'backup.backupEntriesTable.thisEntryHasNoLocations',
            'This entry has no locations selected.',
          )}
        </p>
      )}
      {row.locationIds.map((id) => (
        <div key={id} className="space-y-1.5">
          <div className="text-[11px] font-medium text-foreground-subtle">
            {destById.get(id)?.displayName ?? id}
          </div>
          <ArchiveList
            destinationId={id}
            restoreSupported={destById.get(id)?.restoreSupported ?? true}
            {...(onOpenRestoreWizard ? { onOpenRestoreWizard } : {})}
          />
        </div>
      ))}
    </div>
  )
}
