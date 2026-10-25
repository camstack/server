/**
 * CleanupSection — Recordings → Management.
 *
 * One operator pass that reclaims leftover analytics (DB + blobs) and
 * forgets ghost footage rows on frozen locations. Optional debug-media
 * sweep. The hub method returns immediately; this panel polls progress
 * so the browser never waits on the 60 s UDS deadline.
 */

import type { StorageCleanupJob } from '@camstack/types'
import {
  useConfirm,
  useStorageMigrationCleanupCancel,
  useStorageMigrationCleanupStart,
  useStorageMigrationCleanupStatus,
} from '@camstack/ui-library'
import { Loader2, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useCapabilityPresence } from '../../lib/capability-presence'
import { formatBytes } from '../../lib/format-size'
import { HOUSEKEEPING_BTN } from './housekeeping-btn'
import { useTranslation } from 'react-i18next'

const STORAGE_MIGRATION_CAPABILITY_ID = 'storage-migration'

const ACTIVE = new Set(['orphans', 'debug-media', 'ghost-ledger'])

function progressLine(job: StorageCleanupJob): string {
  const bits = [
    `${job.orphansReclaimed} orphan rows (${formatBytes(job.orphanBytesReclaimed)})`,
    job.includeDebugMedia
      ? `${job.debugMediaReclaimed} debug files (${formatBytes(job.debugMediaBytesReclaimed)})`
      : null,
    `${job.ghostsForgotten} ghost rows (${formatBytes(job.ghostBytesForgotten)})`,
  ].filter((b): b is string => b !== null)
  return bits.join(' · ')
}

/**
 * The cleanup panel is OPTIONAL — it exists only where `storage-migration` is
 * installed — so this section has to answer "is it there?" before it draws.
 *
 * `presence !== 'present'` collapsed that tri-state (D315): a query still in
 * flight and a registry that never answered both rendered exactly what "not
 * installed" renders, which is nothing. On a hub whose registry call takes a
 * beat, the panel simply was not there, and no surface said why — an empty
 * space is a CLAIM, and it was making one it had not checked.
 *
 * `pending` renders nothing too, deliberately: this is a section inside an
 * already-loading page, and a second spinner beside the page's own would say
 * less than silence. The difference that matters is that it is now a decided
 * silence — and `unknown`, where the registry refused to answer, is not
 * silent, because that one is worth saying out loud.
 */
export function CleanupSection() {
  const { t } = useTranslation()
  const presence = useCapabilityPresence(STORAGE_MIGRATION_CAPABILITY_ID)
  if (presence === 'pending') return null
  if (presence === 'unknown') {
    return (
      <p className="py-2 text-xs text-foreground-subtle">
        {t(
          'recordings.cleanupSection.couldNotCheckWhetherStorage',
          'Could not check whether storage cleanup is installed on this hub.',
        )}
      </p>
    )
  }
  if (presence !== 'present') return null
  return <CleanupPanel />
}

function CleanupPanel() {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const [includeDebugMedia, setIncludeDebugMedia] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const jobQuery = useStorageMigrationCleanupStatus({}, { refetchInterval: 2_000 })
  const job = jobQuery.data ?? null
  const running = job !== null && ACTIVE.has(job.phase)

  const startCleanup = useStorageMigrationCleanupStart()
  const cancelCleanup = useStorageMigrationCleanupCancel()

  const handleStart = async (): Promise<void> => {
    const ok = await confirm({
      title: t('recordings.cleanupSection.runStorageCleanup', 'Run storage cleanup?'),
      message: includeDebugMedia
        ? t(
            'recordings.cleanupSection.reclaimsLeftoverAnalyticsRowsAnd',
            'Reclaims leftover analytics rows and files, debug stills/filmstrips, and ghost footage rows on frozen locations. Safe to re-run.',
          )
        : t(
            'recordings.cleanupSection.reclaimsLeftoverAnalyticsRowsAnd2',
            'Reclaims leftover analytics rows and files, and ghost footage rows on frozen locations. Debug stills are left alone. Safe to re-run.',
          ),
      confirmLabel: t('recordings.cleanupSection.runCleanup', 'Run cleanup'),
      variant: 'danger',
    })
    if (!ok) return
    setActionError(null)
    try {
      await startCleanup.mutateAsync({ includeDebugMedia })
      await jobQuery.refetch()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleCancel = async (): Promise<void> => {
    if (!job) return
    const ok = await confirm({
      title: t('recordings.cleanupSection.cancelCleanup', 'Cancel cleanup?'),
      message: t(
        'recordings.cleanupSection.stopsAfterTheCurrentStep',
        'Stops after the current step. Work already done stays done.',
      ),
      confirmLabel: t('recordings.cleanupSection.cancelCleanup2', 'Cancel cleanup'),
      variant: 'danger',
    })
    if (!ok) return
    try {
      await cancelCleanup.mutateAsync({ jobId: job.jobId })
      await jobQuery.refetch()
    } catch {
      /* poll shows the truth */
    }
  }

  return (
    <section className="rounded-md border border-border bg-surface p-4">
      <h2 className="text-sm font-semibold text-foreground">
        {t('recordings.cleanupSection.cleanup', 'Cleanup')}
      </h2>
      <p className="mt-1 text-[11px] text-foreground-subtle">
        {t(
          'recordings.cleanupSection.onePassOverLeftoverAnalytics',
          'One pass over leftover analytics (database + files) and ghost footage rows on frozen locations. Does not time out — progress updates here until it finishes.',
        )}
      </p>

      <label className="mt-3 flex items-start gap-2 text-[11px] text-foreground">
        <input
          type="checkbox"
          checked={includeDebugMedia}
          disabled={running}
          onChange={(e) => {
            setIncludeDebugMedia(e.target.checked)
          }}
          className="mt-0.5 h-3.5 w-3.5 accent-primary"
        />
        <span>
          {t(
            'recordings.cleanupSection.alsoRemoveDebugMediaMotion',
            'Also remove debug media (motion stills and track filmstrips)',
          )}
        </span>
      </label>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={running || startCleanup.isPending}
          onClick={() => {
            void handleStart()
          }}
          className={HOUSEKEEPING_BTN}
        >
          {(running || startCleanup.isPending) && <Loader2 className="h-3 w-3 animate-spin" />}
          <Trash2 className="h-3 w-3" />
          {t('recordings.cleanupSection.runCleanup', 'Run cleanup')}
        </button>
        {running && (
          <button
            type="button"
            onClick={() => {
              void handleCancel()
            }}
            className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] font-medium text-danger hover:bg-danger/10"
          >
            {t('common.cancel', 'Cancel')}
          </button>
        )}
      </div>

      {actionError && <p className="mt-2 text-[11px] text-danger">{actionError}</p>}

      {job && (
        <div className="mt-3 space-y-1 rounded-md border border-border px-2.5 py-2">
          <p className="text-xs text-foreground">
            {t('recordings.cleanupSection.phase', 'Phase:')}{' '}
            <span className="font-medium">{job.phase}</span>
            {running && <Loader2 className="ml-2 inline h-3 w-3 animate-spin text-primary" />}
          </p>
          {job.detail && <p className="text-[11px] text-foreground-subtle">{job.detail}</p>}
          <p className="text-[11px] text-foreground-subtle">{progressLine(job)}</p>
          {job.error && <p className="text-[11px] text-danger">{job.error}</p>}
        </div>
      )}
    </section>
  )
}
