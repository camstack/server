/**
 * DiskReconcileSection — Recordings → Management disk-wins reconcile.
 *
 * Starts the fleet walk in the orchestrator process (start returns
 * immediately) and polls status. The browser does not walk cameras —
 * that work outlives the tRPC/UDS 60s timeout.
 *
 * Disco wins for recordings, tracks, events and media, including
 * snapshot-less motion/audio rows. Enrolled gallery media is not probed.
 */

import {
  useConfirm,
  usePipelineOrchestratorGetReconcileFromDiskStatus,
  usePipelineOrchestratorReconcileFromDisk,
  Button,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { HardDrive, Loader2 } from 'lucide-react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'

const STATUS_POLL_MS = 2_000

export function DiskReconcileSection() {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const queryClient = useQueryClient()
  const start = usePipelineOrchestratorReconcileFromDisk()
  const statusQuery = usePipelineOrchestratorGetReconcileFromDiskStatus(undefined, {
    refetchInterval: (query) => (query.state.data?.state === 'running' ? STATUS_POLL_MS : false),
  })
  const job = statusQuery.data
  const running = job?.state === 'running'
  const busy = running || start.isPending

  useEffect(() => {
    if (job?.state !== 'done' || job.finishedAtMs === null) return
    void queryClient.invalidateQueries({ queryKey: [['recording']] })
    void queryClient.invalidateQueries({ queryKey: [['pipelineAnalytics']] })
  }, [job?.state, job?.finishedAtMs, queryClient])

  const handleReconcile = async (): Promise<void> => {
    const ok = await confirm({
      title: t(
        'recordings.diskReconcileSection.reconcileStorageFromDisk',
        'Reconcile storage from disk?',
      ),
      message: t(
        'recordings.diskReconcileSection.makesTheDatabaseMatchThe',
        'Makes the database match the filesystem: recordings index, tracks, events and media whose files are gone. Favourited tracks without files are deleted. Snapshot-less motion/audio events are deleted. Enrolled identities stay. This cannot be undone.',
      ),
      confirmLabel: t('recordings.diskReconcileSection.reconcile', 'Reconcile'),
      variant: 'warning',
    })
    if (!ok) return
    await start.mutateAsync()
    await statusQuery.refetch()
  }

  const label = running
    ? job.total > 0
      ? `Reconciling ${String(job.completed)}/${String(job.total)}…`
      : 'Reconciling…'
    : start.isPending
      ? 'Reconciling…'
      : 'Reconcile from disk'

  return (
    <section className="rounded-md border border-border bg-surface p-4">
      <h3 className="text-sm font-semibold text-foreground">
        {t('recordings.diskReconcileSection.diskReconcile', 'Disk reconcile')}
      </h3>
      <p className="mt-1 text-[11px] text-foreground-subtle">
        {t(
          'recordings.diskReconcileSection.deletesDatabaseRowsWhoseFiles',
          'Deletes database rows whose files are gone. Enrolled identities stay.',
        )}
      </p>
      <div className="mt-3 flex flex-col gap-2">
        <Button
          variant="unstyled"
          type="button"
          onClick={() => void handleReconcile()}
          disabled={busy}
          className="inline-flex w-fit items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium border border-border text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <HardDrive className="h-3.5 w-3.5" />
          )}
          {label}
        </Button>
        {job?.state === 'done' ? (
          <p className="text-[11px] text-foreground-subtle">
            {t('recordings.diskReconcileSection.lastRun', 'Last run:')}{' '}
            {t('recordings.diskReconcileSection.summary', {
              completed: String(job.completed),
              tracks: String(job.tracks),
              events: String(job.events),
              media: String(job.mediaDropped),
            })}
            {job.failed.length > 0
              ? t('recordings.diskReconcileSection.failed', ', {{value1}} failed ({{value2}})', {
                  value1: String(job.failed.length),
                  value2: job.failed.join(', '),
                })
              : ''}
            .
          </p>
        ) : null}
        {job?.state === 'error' && job.error !== null ? (
          <p className="text-[11px] text-destructive">
            {t('recordings.diskReconcileSection.reconcileFailed', 'Reconcile failed:')} {job.error}
          </p>
        ) : null}
      </div>
    </section>
  )
}
