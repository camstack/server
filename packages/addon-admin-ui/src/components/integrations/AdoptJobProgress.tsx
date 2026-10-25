import type { AdoptionJob } from '@camstack/types'
import {
  useDeviceManagerAdoptionCancelJob,
  useDeviceManagerAdoptionListJobs,
} from '@camstack/ui-library'
import { AlertTriangle, CheckCircle2, Loader2, XCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'

/**
 * Live progress for a background adoption job.
 *
 * Adoption used to run inside the `adoptionAdopt` request, so a batch that
 * exceeded the transport deadline reported a bare timeout — while the provider
 * carried on adopting. Measured on the live hub: a 25-candidate adopt "failed"
 * at 60s having landed 9, reached 17 by 87s, and finished all 25 at ~130s. The
 * operator saw an error and could not learn any of that.
 *
 * The job surface reports per-candidate outcomes, so this strip can answer the
 * only question that matters mid-failure — which ones landed.
 *
 * Poll, not events: `adoptionListJobs` is the reconcile path and it stops the
 * moment nothing is running, so an idle modal costs nothing.
 */
interface AdoptJobProgressProps {
  readonly addonId: string
  readonly integrationId: string
  readonly jobId: string
  /** Called once the job reaches a terminal state, so the caller can refetch. */
  readonly onFinished: () => void
}

const POLL_MS = 1_500

export function AdoptJobProgress({
  addonId,
  integrationId,
  jobId,
  onFinished,
}: AdoptJobProgressProps) {
  const { t } = useTranslation()
  const cancelMutation = useDeviceManagerAdoptionCancelJob()

  const jobsQuery = useDeviceManagerAdoptionListJobs(
    { addonId, integrationId },
    {
      refetchInterval: (query: { state: { data?: readonly AdoptionJob[] } }) =>
        (query.state.data ?? []).some((j) => j.state === 'running') ? POLL_MS : false,
    },
  )

  const job = (jobsQuery.data ?? []).find((j) => j.jobId === jobId)
  if (!job) return null

  const running = job.state === 'running'
  const done = job.processed
  const pct = job.total > 0 ? Math.round((done / job.total) * 100) : 0

  if (!running && job.finishedAt !== null) onFinished()

  // One string, one text node: the counts are read together ("7 added, 1 already
  // there, 1 failed of 25"), and splitting them across nodes makes the line
  // impossible to assert on as the single sentence an operator actually reads.
  // Counts stay OUTSIDE the translation: a placeholder-interpolated string is
  // one opaque blob to every reader that is not i18next, including the tests.
  const parts: string[] = [
    `${done}/${job.total} ${t('integrations.adoptJobProcessed', { defaultValue: 'processed' })}`,
  ]
  if (job.adopted > 0) {
    parts.push(`${job.adopted} ${t('integrations.adoptJobAdded', { defaultValue: 'added' })}`)
  }
  if (job.alreadyAdopted > 0) {
    parts.push(
      `${job.alreadyAdopted} ${t('integrations.adoptJobSkipped', { defaultValue: 'already there' })}`,
    )
  }
  if (job.failed > 0) {
    parts.push(`${job.failed} ${t('integrations.adoptJobFailed', { defaultValue: 'failed' })}`)
  }
  const summary = parts.join(' · ')

  return (
    <div className="border-t border-border px-5 py-3 shrink-0 space-y-2">
      <div className="flex items-center gap-2">
        {running ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary shrink-0" />
        ) : job.failed > 0 ? (
          <AlertTriangle className="h-3.5 w-3.5 text-destructive shrink-0" />
        ) : job.state === 'cancelled' ? (
          <XCircle className="h-3.5 w-3.5 text-foreground-subtle shrink-0" />
        ) : (
          <CheckCircle2 className="h-3.5 w-3.5 text-primary shrink-0" />
        )}
        <p className="text-[11px] text-foreground">{summary}</p>
        {running && (
          <button
            onClick={() => cancelMutation.mutate({ jobId })}
            className="ml-auto rounded-lg border border-border px-2 py-1 text-[11px] text-foreground-subtle hover:text-foreground transition-colors"
          >
            {t('integrations.adoptJobCancel', { defaultValue: 'Stop' })}
          </button>
        )}
      </div>

      <div className="h-1 w-full rounded-full bg-border overflow-hidden">
        <div
          className="h-full bg-primary transition-all"
          style={{ width: `${pct}%` }}
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
        />
      </div>

      {/* Every failure is named. A batch that half-worked must never be
          reported as a single opaque error again. */}
      {job.results
        .filter((r) => r.outcome === 'failed')
        .slice(0, 5)
        .map((r) => (
          <p key={r.childNativeId} className="text-[11px] text-destructive">
            {r.childNativeId}: {r.error}
          </p>
        ))}
    </div>
  )
}
