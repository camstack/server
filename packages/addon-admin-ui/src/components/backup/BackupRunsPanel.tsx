/**
 * BackupRunsPanel — live view of backup RUNS (D342).
 *
 * Born from the 2026-09-04 incident: the operator watched a runaway
 * backup fill the disk (staging 5.1 GB → 18 GB, load 62) and had no
 * way to see it or stop it — the runs were found with `du`. This panel
 * is the answer:
 *
 *   - `backup.listRuns` polled while visible (2 s when a run is
 *     active, 5 s idle) — queued, running and the bounded finished
 *     history. For a run in flight the live `stagedBytes` counter is
 *     the point: the number that would have shown the runaway in
 *     seconds.
 *   - A Cancel control per queued/running run → `backup.cancel`. The
 *     confirm states the consequences precisely (they differ): a
 *     queued run simply never starts; a running one loses its
 *     half-written archive and the destination still uploading, while
 *     destinations that already completed KEEP their archive.
 *   - Outcomes are reported honestly: a run that stopped early is
 *     "Stopped", never rounded off to success; a failed run shows its
 *     error and which destinations completed vs failed.
 *
 * D315: an unanswered query must not render as "no runs" — the panel
 * distinguishes pending ("Checking…") from an answered-empty list.
 */
import type { BackupRun } from '@camstack/types'
import { useBackupCancel, useBackupListRuns, useConfirm, Button } from '@camstack/ui-library'
import {
  Ban,
  CheckCircle2,
  CircleSlash,
  Clock,
  HardDriveDownload,
  Loader2,
  UploadCloud,
  XCircle,
} from 'lucide-react'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from '../../i18n/index'
import { formatBytes } from '../../lib/format-size'

/** Poll cadence while at least one run is queued or running. */
const ACTIVE_POLL_MS = 2_000
/**
 * Idle cadence. Kept short on purpose: a scheduled run can start at
 * any minute and must surface without a page reload — this is the
 * screen the operator opens when a backup misbehaves.
 */
const IDLE_POLL_MS = 5_000

export function isActiveRun(run: Pick<BackupRun, 'state'>): boolean {
  return run.state === 'queued' || run.state === 'running'
}

export interface CancelPrompt {
  readonly title: string
  readonly message: string
  readonly confirmLabel: string
  readonly variant: 'danger' | 'warning'
}

/**
 * The consequence text for cancelling a run. Queued and running differ
 * MATERIALLY — the operator must not have to guess which work survives:
 *
 *   - queued: nothing has been written; the run simply never starts.
 *   - running: the half-written staging archive is deleted and the
 *     destination currently uploading discards its partial copy;
 *     destinations that already completed keep their archive.
 */
export function describeCancelConsequence(
  run: Pick<BackupRun, 'state' | 'completedDestinationIds'>,
): CancelPrompt {
  if (run.state === 'queued') {
    return {
      title: i18n.t('backup.backupRunsPanel.cancelQueuedBackupRun', 'Cancel queued backup run?'),
      message: i18n.t(
        'backup.backupRunsPanel.thisRunHasNotStarted',
        'This run has not started. Cancelling removes it from the queue — nothing has been written, nothing is deleted.',
      ),
      confirmLabel: i18n.t('backup.backupRunsPanel.cancelRun', 'Cancel run'),
      variant: 'warning',
    }
  }
  const kept = run.completedDestinationIds.length
  const keptSentence =
    kept > 0
      ? `${kept === 1 ? 'The 1 destination' : `The ${kept} destinations`} that already completed KEEP${kept === 1 ? 'S' : ''} the archive.`
      : 'No destination has completed yet, so nothing will be kept.'
  return {
    title: i18n.t('backup.backupRunsPanel.stopThisBackupRun', 'Stop this backup run?'),
    message: i18n.t(
      'backup.backupRunsPanel.theHalfWrittenStagingArchive',
      'The half-written staging archive is deleted and the destination currently uploading discards its partial copy. {{keptSentence}}',
      { keptSentence },
    ),
    confirmLabel: i18n.t('backup.backupRunsPanel.stopRun', 'Stop run'),
    variant: 'danger',
  }
}

export function BackupRunsPanel() {
  const confirm = useConfirm()
  const [cancelingId, setCancelingId] = useState<string | null>(null)

  const query = useBackupListRuns(undefined, {
    refetchInterval: (q) =>
      (q.state.data ?? []).some(isActiveRun) ? ACTIVE_POLL_MS : IDLE_POLL_MS,
  })
  const cancel = useBackupCancel({
    onSettled: () => {
      setCancelingId(null)
      void query.refetch()
    },
  })

  const handleCancelRequest = useCallback(
    async (run: BackupRun): Promise<void> => {
      const prompt = describeCancelConsequence(run)
      const ok = await confirm(prompt)
      if (!ok) return
      setCancelingId(run.id)
      cancel.mutate({ runId: run.id })
    },
    [confirm, cancel],
  )

  // D315: not-yet-known must never look like not-present. `data` is
  // only trusted once the query has ANSWERED — no `(data ?? [])`.
  const queryState: RunsQueryState = query.isError
    ? 'error'
    : query.data === undefined
      ? 'pending'
      : 'ready'

  return (
    <BackupRunsPanelView
      queryState={queryState}
      runs={query.data ?? []}
      cancelingId={cancelingId}
      onCancelRequest={(run) => {
        void handleCancelRequest(run)
      }}
      now={Date.now()}
    />
  )
}

export type RunsQueryState = 'pending' | 'error' | 'ready'

export interface BackupRunsPanelViewProps {
  readonly queryState: RunsQueryState
  /** Only meaningful when `queryState === 'ready'`. */
  readonly runs: readonly BackupRun[]
  readonly cancelingId: string | null
  readonly onCancelRequest: (run: BackupRun) => void
  /** Injected clock so elapsed times are testable. */
  readonly now: number
}

/**
 * Presentational half — exported for tests. Never returns null while
 * loading: the section keeps its frame so the page cannot blank.
 */
export function BackupRunsPanelView({
  queryState,
  runs,
  cancelingId,
  onCancelRequest,
  now,
}: BackupRunsPanelViewProps) {
  const { t } = useTranslation()
  const hasActive = queryState === 'ready' && runs.some(isActiveRun)
  // Three sections with three NATURAL orders, grouped by filtering so
  // the server's relative order is preserved verbatim: `listRuns`
  // already answers in execution order (running, then queued in the
  // exact order the orchestrator will start them, then finished
  // newest-first). No client-side sort — a timestamp sort here once
  // put the run that starts NEXT at the BOTTOM of the list.
  const runningRuns = runs.filter((r) => r.state === 'running')
  const queuedRuns = runs.filter((r) => r.state === 'queued')
  const finishedRuns = runs.filter((r) => !isActiveRun(r))
  const ordered = [...runningRuns, ...queuedRuns, ...finishedRuns]
  return (
    <section className="rounded-lg border border-border bg-surface">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <h2 className="text-xs font-semibold text-foreground">
          {t('backup.backupRunsPanel.runs', 'Runs')}
        </h2>
        {hasActive && (
          <span
            className="inline-flex items-center gap-1 text-[10px] font-medium text-primary"
            title={t('backup.backupRunsPanel.aBackupRunIsIn', 'A backup run is in progress')}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
            {t('backup.runsPanel.live')}
          </span>
        )}
        <span className="ml-auto text-[10px] text-foreground-subtle">
          {t(
            'backup.backupRunsPanel.oneRunExecutesAtA',
            'One run executes at a time — queued runs wait in line.',
          )}
        </span>
      </div>

      {queryState === 'pending' && (
        <div className="px-3 py-2.5 text-xs text-foreground-subtle animate-pulse">
          {t('backup.backupRunsPanel.checkingForBackupRuns', 'Checking for backup runs…')}
        </div>
      )}
      {queryState === 'error' && (
        <div className="px-3 py-2.5 text-xs text-danger">
          {t(
            'backup.backupRunsPanel.couldNotReadBackupRuns',
            'Could not read backup runs — the orchestrator did not answer.',
          )}
        </div>
      )}
      {queryState === 'ready' && runs.length === 0 && (
        <div className="px-3 py-2.5 text-xs text-foreground-subtle italic">
          {t(
            'backup.backupRunsPanel.noBackupRunsYetRuns',
            'No backup runs yet. Runs appear here the moment one starts — manual or scheduled.',
          )}
        </div>
      )}
      {queryState === 'ready' && runs.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs min-w-[720px]">
            <thead>
              <tr className="text-foreground-subtle bg-background/30">
                <th className="text-left px-3 py-1.5 font-medium">
                  {t('backup.backupRunsPanel.run', 'Run')}
                </th>
                <th className="text-left px-3 py-1.5 font-medium">
                  {t('backup.backupRunsPanel.state', 'State')}
                </th>
                <th className="text-left px-3 py-1.5 font-medium">
                  {t('backup.backupRunsPanel.progress', 'Progress')}
                </th>
                <th className="text-left px-3 py-1.5 font-medium">
                  {t('backup.backupRunsPanel.destinations', 'Destinations')}
                </th>
                <th className="text-left px-3 py-1.5 font-medium">
                  {t('backup.backupRunsPanel.timing', 'Timing')}
                </th>
                <th className="text-right px-3 py-1.5 font-medium w-28">
                  {t('backup.backupRunsPanel.actions', 'Actions')}
                </th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((run) => (
                <RunRow
                  key={run.id}
                  run={run}
                  canceling={cancelingId === run.id}
                  onCancelRequest={onCancelRequest}
                  now={now}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

interface RunRowProps {
  readonly run: BackupRun
  readonly canceling: boolean
  readonly onCancelRequest: (run: BackupRun) => void
  readonly now: number
}

function RunRow({ run, canceling, onCancelRequest, now }: RunRowProps) {
  const { t } = useTranslation()
  const active = isActiveRun(run)
  return (
    <tr className="border-t border-border hover:bg-primary/5 align-top">
      <td className="px-3 py-2">
        <div className="text-foreground" title={run.id}>
          {run.label ?? (
            <span className="text-foreground-subtle italic">{t('backup.runsPanel.manual')}</span>
          )}
        </div>
      </td>
      <td className="px-3 py-2">
        <StateBadge run={run} />
        {run.state === 'failed' && run.error !== undefined && (
          <div className="mt-1 text-[10px] text-danger max-w-56 truncate" title={run.error}>
            {run.error}
          </div>
        )}
      </td>
      <td className="px-3 py-2">
        <ProgressCell run={run} />
      </td>
      <td className="px-3 py-2">
        <DestinationsCell run={run} />
      </td>
      <td className="px-3 py-2 text-foreground-subtle tabular-nums">
        <TimingCell run={run} now={now} />
      </td>
      <td className="px-3 py-2">
        <div className="flex justify-end">
          {active && (
            <Button
              variant="unstyled"
              onClick={() => onCancelRequest(run)}
              disabled={canceling}
              className="inline-flex items-center gap-1 rounded px-2 py-1 text-[10px] font-medium text-danger hover:bg-danger/10 disabled:opacity-50"
              title={
                run.state === 'queued'
                  ? t(
                      'backup.backupRunsPanel.removeThisRunFromThe',
                      'Remove this run from the queue before it starts',
                    )
                  : t(
                      'backup.backupRunsPanel.stopThisRunTheHalf',
                      'Stop this run — the half-written archive is discarded',
                    )
              }
            >
              {canceling ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Ban className="h-3 w-3" />
              )}
              {run.state === 'queued'
                ? t('common.cancel', 'Cancel')
                : t('backup.backupRunsPanel.stop', 'Stop')}
            </Button>
          )}
        </div>
      </td>
    </tr>
  )
}

function StateBadge({ run }: { readonly run: BackupRun }) {
  const { t } = useTranslation()
  switch (run.state) {
    case 'queued':
      return (
        <span className="inline-flex items-center gap-1 rounded bg-foreground-subtle/10 px-1.5 py-0.5 text-[10px] font-medium text-foreground-subtle">
          <Clock className="h-3 w-3" />
          {t('backup.backupRunsPanel.queued', 'Queued')}
        </span>
      )
    case 'running':
      return (
        <span className="inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
          <Loader2 className="h-3 w-3 animate-spin" />
          {run.phase === 'uploading'
            ? t('backup.backupRunsPanel.uploading', 'Uploading')
            : t('backup.backupRunsPanel.buildingArchive', 'Building archive')}
        </span>
      )
    case 'succeeded':
      return (
        <span className="inline-flex items-center gap-1 rounded bg-success/10 px-1.5 py-0.5 text-[10px] font-medium text-success">
          <CheckCircle2 className="h-3 w-3" />
          {t('backup.backupRunsPanel.succeeded', 'Succeeded')}
        </span>
      )
    case 'failed':
      return (
        <span className="inline-flex items-center gap-1 rounded bg-danger/10 px-1.5 py-0.5 text-[10px] font-medium text-danger">
          <XCircle className="h-3 w-3" />
          {t('backup.backupRunsPanel.failed', 'Failed')}
        </span>
      )
    case 'cancelled':
      // Stopped early is an outcome of its own — never rounded off to
      // success, even when some destinations completed first.
      return (
        <span
          className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300"
          title={t(
            'backup.backupRunsPanel.stoppedBeforeCompletingEveryDestination',
            'Stopped before completing every destination — not a success',
          )}
        >
          <CircleSlash className="h-3 w-3" />
          {t('backup.backupRunsPanel.stopped', 'Stopped')}
        </span>
      )
  }
}

/**
 * The number that would have shown the runaway in seconds: while
 * building, the live compressed size of the staging archive, growing
 * refresh over refresh.
 */
function ProgressCell({ run }: { readonly run: BackupRun }) {
  const { t } = useTranslation()
  if (run.state === 'queued') {
    // Position comes from the orchestrator's own queue order
    // (`queuePosition`), never from a client-side sort — the panel must
    // not claim an order the executor will not honour.
    return (
      <span className="text-foreground-subtle">
        {run.queuePosition !== undefined ? (
          <span className="inline-flex items-center gap-1">
            <span
              className={
                run.queuePosition === 1
                  ? 'rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary'
                  : 'rounded bg-foreground-subtle/10 px-1.5 py-0.5 text-[10px] font-medium'
              }
            >
              {positionLabel(run.queuePosition)}
            </span>
            {t('backup.backupRunsPanel.inLine', 'in line')}
          </span>
        ) : (
          <span className="italic">
            {t('backup.backupRunsPanel.waitingItsTurn', 'waiting its turn')}
          </span>
        )}
      </span>
    )
  }
  if (run.state === 'running' && run.phase === 'building') {
    return (
      <span className="inline-flex items-center gap-1.5 text-foreground">
        <HardDriveDownload className="h-3 w-3 text-primary" />
        <span className="tabular-nums font-medium animate-pulse">
          {formatBytes(run.stagedBytes)}
        </span>
        <span className="text-foreground-subtle">
          {t('backup.backupRunsPanel.stagedSoFar', 'staged so far')}
        </span>
      </span>
    )
  }
  if (run.state === 'running') {
    const total = run.archiveSizeBytes
    return (
      <span className="inline-flex items-center gap-1.5 text-foreground">
        <UploadCloud className="h-3 w-3 text-primary" />
        <span className="tabular-nums font-medium">
          {formatBytes(run.uploadedBytes)}
          {total !== undefined ? ` / ${formatBytes(total)}` : ''}
        </span>
        <span className="text-foreground-subtle">
          {t('backup.backupRunsPanel.toCurrentDestination', 'to current destination')}
        </span>
      </span>
    )
  }
  const finalSize = run.archiveSizeBytes ?? (run.stagedBytes > 0 ? run.stagedBytes : undefined)
  if (finalSize === undefined) {
    return <span className="text-foreground-subtle italic">—</span>
  }
  return (
    <span className="tabular-nums text-foreground">
      {t('backup.runsPanel.archiveSize', { size: formatBytes(finalSize) })}
    </span>
  )
}

function DestinationsCell({ run }: { readonly run: BackupRun }) {
  const { t } = useTranslation()
  const total = run.destinationIds.length
  const completed = run.completedDestinationIds.length
  const failed = run.failedDestinationIds.length
  if (total === 0) {
    return (
      <span className="text-foreground-subtle italic">
        {t('backup.backupRunsPanel.notResolvedYet', 'not resolved yet')}
      </span>
    )
  }
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-foreground-subtle" title={run.destinationIds.join(', ')}>
        {t('backup.runsPanel.targets', { count: total })}
      </span>
      <span className="inline-flex items-center gap-2 text-[10px]">
        {completed > 0 && (
          <span
            className="text-success"
            title={t('backup.backupRunsPanel.keptTheirArchive', 'Kept their archive: {{value1}}', {
              value1: run.completedDestinationIds.join(', '),
            })}
          >
            {t('backup.runsPanel.completed', { count: completed })}
          </span>
        )}
        {failed > 0 && (
          <span
            className="text-danger"
            title={t('backup.backupRunsPanel.failed2', 'Failed: {{value1}}', {
              value1: run.failedDestinationIds.join(', '),
            })}
          >
            {t('backup.runsPanel.failedCount', { count: failed })}
          </span>
        )}
      </span>
    </div>
  )
}

function TimingCell({ run, now }: { readonly run: BackupRun; readonly now: number }) {
  const { t } = useTranslation()
  if (run.state === 'queued') {
    return (
      <span>
        {t('backup.runsPanel.queuedAgo', { elapsed: formatElapsed(now - run.requestedAt) })}
      </span>
    )
  }
  if (run.startedAt === undefined) {
    return <span>—</span>
  }
  if (run.finishedAt === undefined) {
    return (
      <span>
        {t('backup.runsPanel.runningFor', { elapsed: formatElapsed(now - run.startedAt) })}
      </span>
    )
  }
  return (
    <div className="flex flex-col gap-0.5">
      <span>{formatTimestamp(run.finishedAt)}</span>
      <span className="text-[10px]">
        {t('backup.runsPanel.took', { elapsed: formatElapsed(run.finishedAt - run.startedAt) })}
      </span>
    </div>
  )
}

/**
 * Human label for a 1-based queue position: `next`, `2nd`, `3rd`,
 * `4th`… Ordinal suffixes handle the teens correctly, though a backup
 * queue that deep is its own incident.
 */
export function positionLabel(position: number): string {
  if (position <= 1) return 'next'
  const mod100 = position % 100
  if (mod100 >= 11 && mod100 <= 13) return `${position}th`
  switch (position % 10) {
    case 1:
      return `${position}st`
    case 2:
      return `${position}nd`
    case 3:
      return `${position}rd`
    default:
      return `${position}th`
  }
}

/** Compact elapsed rendering: `42s`, `3m 12s`, `1h 04m`. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes < 60) return `${totalMinutes}m ${String(totalSeconds % 60).padStart(2, '0')}s`
  const hours = Math.floor(totalMinutes / 60)
  return `${hours}h ${String(totalMinutes % 60).padStart(2, '0')}m`
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}
