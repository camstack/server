/**
 * BackupNowDialog — "Back up now": pick what to carry, then run once to every
 * enabled destination. The default selection is settings (what the nightly
 * carries); the choice is sent as `backup.trigger({ databases })`.
 */
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  useBackupTrigger,
} from '@camstack/ui-library'
import type { DataStoreDatabase } from '@camstack/types'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2, Play } from 'lucide-react'
import { useState } from 'react'
import { BackupDatabasePicker } from './BackupDatabasePicker'
import { DEFAULT_DATABASE_SELECTION, triggerInputFor } from './backup-databases'
import { useTranslation } from 'react-i18next'

export interface BackupNowDialogProps {
  readonly onClose: () => void
}

export function BackupNowDialog({ onClose }: BackupNowDialogProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [databases, setDatabases] = useState<ReadonlySet<DataStoreDatabase>>(
    new Set(DEFAULT_DATABASE_SELECTION),
  )

  const trigger = useBackupTrigger({
    onMutate: () => {
      void queryClient.invalidateQueries({ queryKey: [['backup', 'listRuns']] })
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [['backup', 'listArchives']] })
      void queryClient.invalidateQueries({ queryKey: [['backup', 'listDestinations']] })
      void queryClient.invalidateQueries({ queryKey: [['backup', 'listRuns']] })
      onClose()
    },
  })

  const run = (): void => {
    if (databases.size === 0) return
    trigger.mutate(triggerInputFor(databases))
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent width="md" placement="sheet-on-mobile" scroll="body">
        <DialogHeader>
          <DialogTitle>{t('backup.backupNowDialog.backUpNow', 'Back up now')}</DialogTitle>
          <p className="text-xs text-foreground-subtle">
            {t(
              'backup.backupNowDialog.runsOnceAndWritesThe',
              'Runs once and writes the archive to every enabled backup location.',
            )}
          </p>
        </DialogHeader>
        <DialogBody>
          <div className="p-4">
            <BackupDatabasePicker
              selected={databases}
              onChange={setDatabases}
              disabled={trigger.isPending}
              testId="backup-now-databases"
            />
            {trigger.error && (
              <p role="alert" className="pt-2 text-xs text-danger">
                {trigger.error.message}
              </p>
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            size="sm"
            onClick={run}
            disabled={databases.size === 0 || trigger.isPending}
            data-testid="backup-now-run"
          >
            {trigger.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            {t('backup.backupNowDialog.backUpNow', 'Back up now')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
