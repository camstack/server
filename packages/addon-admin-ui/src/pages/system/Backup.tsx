/**
 * Backup & Restore page.
 *
 * Structure:
 *   - Header: Back up now (pick what to carry) + Restore… + New entry buttons
 *   - Restore-pending banner (visible after `useBackupRestore` resolves
 *     — the restore marker is applied on next boot)
 *   - BackupEncryptionCard — opt-in archive encryption to a backup key the
 *     operator keeps (shown once at setup; restore asks for it). Kept as a
 *     singleton card (LocationCard-style), not a managed list — see
 *     `docs/ui/admin-patterns.md` composite-patterns census.
 *   - BackupRunsPanel — live run state (D342): queued/running/finished
 *     runs with staged-bytes progress and a Cancel/Stop control. The
 *     incident answer: a runaway build is visible here in seconds and
 *     stoppable without restarting the addon.
 *   - BackupEntriesTable — one row per backup ENTRY (DataTable). An entry
 *     binds one cron cadence + retention to a SET of `backups` storage
 *     locations (configured on the Storage page). "Run now" fans a single
 *     archive out to every targeted location. Expanding a row shows the
 *     archives at each location below the table.
 *   - BackupEntryModal — create/edit via ItemFormDialog; open state in the
 *     URL (`?new=1` / `?edit=<entryId>` via `useItemFormUrl`).
 *   - RestoreWizard — modal opened from the top-level button or an
 *     archive row.
 *
 * Storage locations themselves are created / edited on the Storage page;
 * this page only wires them into scheduled entries — no location is
 * created here.
 */

import {
  Button,
  useAddonsRestartServer,
  useBackupListSchedules,
  useConfirm,
  useItemFormUrl,
} from '@camstack/ui-library'
import { Loader2, Play, Plus, RotateCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { AdminPage } from '../../components/AdminPage'
import {
  type ArchiveRefBrief,
  BackupEntriesTable,
  type EntryRow,
} from '../../components/backup/BackupEntriesTable'
import { BackupNowDialog } from '../../components/backup/BackupNowDialog'
import { BackupEncryptionCard } from '../../components/backup/BackupEncryptionCard'
import { BackupEntryModal } from '../../components/backup/BackupEntryModal'
import { BackupRunsPanel } from '../../components/backup/BackupRunsPanel'
import { RestoreWizard } from '../../components/backup/RestoreWizard'
import { useTranslation } from 'react-i18next'

export function BackupPage() {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const restartServer = useAddonsRestartServer()
  const {
    state: formUrl,
    openNew,
    openEdit,
    close: closeForm,
  } = useItemFormUrl({ editKey: 'edit', newKey: 'new' })

  const schedulesQuery = useBackupListSchedules()
  const entries = (schedulesQuery.data ?? []) as readonly EntryRow[]

  const [restoreOpen, setRestoreOpen] = useState<ArchiveRefBrief | null>(null)
  const [restoreOpenAny, setRestoreOpenAny] = useState(false)
  const [restorePending, setRestorePending] = useState(false)
  const [backupNowOpen, setBackupNowOpen] = useState(false)

  const editingEntry =
    formUrl.mode === 'edit' ? (entries.find((e) => e.id === formUrl.id) ?? null) : null

  useEffect(() => {
    if (formUrl.mode === 'edit' && !schedulesQuery.isLoading && editingEntry === null) {
      closeForm()
    }
  }, [formUrl.mode, schedulesQuery.isLoading, editingEntry, closeForm])

  const formOpen = formUrl.mode === 'new' || (formUrl.mode === 'edit' && editingEntry !== null)

  const handleRestartNow = async (): Promise<void> => {
    const ok = await confirm({
      title: t('system.backup.restartServerNow', 'Restart server now?'),
      message: t(
        'system.backup.activeConnectionsWillDropAnd',
        'Active connections will drop and the apply-backup hook will run before boot.',
      ),
      confirmLabel: t('system.backup.restart', 'Restart'),
      variant: 'warning',
    })
    if (!ok) return
    restartServer.mutate({ confirm: true })
  }

  return (
    <AdminPage embedded>
      {/* `AdminPage embedded` renders no header, so the page's actions live in the body. */}
      <div className="flex flex-wrap items-center justify-end gap-2" data-testid="backup-actions">
        <Button
          variant="outline"
          size="sm"
          type="button"
          onClick={() => setBackupNowOpen(true)}
          data-testid="backup-now"
        >
          <Play className="h-3.5 w-3.5" />
          {t('system.backup.backUpNow', 'Back up now')}
        </Button>
        <Button variant="outline" size="sm" type="button" onClick={() => setRestoreOpenAny(true)}>
          <RotateCw className="h-3.5 w-3.5" />
          {t('system.backup.restore', 'Restore…')}
        </Button>
        <Button size="sm" type="button" onClick={openNew} data-testid="backup-new-entry">
          <Plus className="h-3.5 w-3.5" />
          {t('system.backup.newEntry', 'New entry')}
        </Button>
      </div>

      {restorePending && (
        <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 text-xs text-warning">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <RotateCw className="h-3.5 w-3.5" />
              <span>
                {t(
                  'system.backup.restoreScheduledRestartTheServer',
                  'Restore scheduled. Restart the server to apply.',
                )}
              </span>
            </div>
            <Button
              size="sm"
              variant="outline"
              type="button"
              onClick={() => {
                void handleRestartNow()
              }}
              disabled={restartServer.isPending}
            >
              {restartServer.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCw className="h-3.5 w-3.5" />
              )}
              {t('system.backup.restartNow', 'Restart Now')}
            </Button>
          </div>
        </div>
      )}

      <BackupEncryptionCard />

      <BackupRunsPanel />

      <BackupEntriesTable
        onEdit={(entry) => openEdit(entry.id)}
        onOpenRestoreWizard={(ref) => setRestoreOpen(ref)}
      />

      {formOpen && (
        <BackupEntryModal entry={editingEntry} onClose={closeForm} onSaved={closeForm} />
      )}

      {backupNowOpen && <BackupNowDialog onClose={() => setBackupNowOpen(false)} />}

      {(restoreOpen || restoreOpenAny) && (
        <RestoreWizard
          {...(restoreOpen
            ? {
                initialDestinationId: restoreOpen.destinationId,
                initialArchiveId: restoreOpen.archiveId,
              }
            : {})}
          onClose={() => {
            setRestoreOpen(null)
            setRestoreOpenAny(false)
          }}
          onScheduled={() => setRestorePending(true)}
        />
      )}
    </AdminPage>
  )
}
