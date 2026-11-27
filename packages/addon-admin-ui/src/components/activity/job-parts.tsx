/**
 * The pieces of one job the Activity panel and the System → Jobs table share:
 * title, state badge, progress, owner and the row actions. Both surfaces draw
 * them the same way; only the layout around them differs.
 */
import {
  Badge,
  Button,
  useAlert,
  useJobsCancel,
  useJobsCollect,
  useJobsDismiss,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import type { Job } from '@camstack/types'
import { Loader2, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from '../../i18n/index'
import { AlertActionLink } from '../ui/AlertActionLink'
import { useUserNames } from '../access/AccessSection'
import {
  canCancelJob,
  canDismissJob,
  cancelRefusalKey,
  formatJobProgress,
  isSystemOwned,
  jobKindLabelKey,
  jobStateLabelKey,
  jobStateTone,
  readJobProgress,
} from './job-model'

/** The kind's own label; an unknown kind shows its raw id rather than nothing. */
export function useJobKindLabel(job: Pick<Job, 'kind'>): string {
  const { t } = useTranslation()
  return t(jobKindLabelKey(job), { defaultValue: job.kind })
}

/** The producer's title key when this catalogue knows it, else the kind label. */
export function useJobTitle(job: Pick<Job, 'kind' | 'titleKey' | 'titleParams'>): string {
  const { t } = useTranslation()
  const kindLabel = useJobKindLabel(job)
  return i18n.exists(job.titleKey) ? t(job.titleKey, job.titleParams) : kindLabel
}

export function JobStateBadge({ state }: { readonly state: Job['state'] }): ReactNode {
  const { t } = useTranslation()
  return (
    <Badge variant={jobStateTone(state)} className="text-[10px]">
      {t(jobStateLabelKey(state))}
    </Badge>
  )
}

/** Real units when known; a pulsing bar when not — never an empty bar read as 0. */
export function JobProgress({ job }: { readonly job: Pick<Job, 'state' | 'progress'> }): ReactNode {
  const reading = readJobProgress(job)
  const text = formatJobProgress(reading)
  if (reading.kind === 'none') return null
  return (
    <div className="flex items-center gap-2">
      <div className="h-1 flex-1 overflow-hidden rounded-full bg-border">
        {reading.kind === 'determinate' ? (
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${String(reading.percent)}%` }} // ui-check-ok: a computed progress width has no token
            role="progressbar"
            aria-valuenow={Math.round(reading.percent)}
            aria-valuemin={0}
            aria-valuemax={100}
          />
        ) : (
          <div
            className="h-full w-full animate-pulse rounded-full bg-primary/40"
            role="progressbar"
          />
        )}
      </div>
      {text !== null && (
        <span className="shrink-0 font-mono text-[10px] text-foreground-subtle">{text}</span>
      )}
    </div>
  )
}

/** Admins see whose job it is; automatic work says so instead of showing an id. */
export function JobOwner({ job }: { readonly job: Pick<Job, 'ownerUserId'> }): ReactNode {
  const { t } = useTranslation()
  const names = useUserNames()
  if (isSystemOwned(job)) return <>{t('activity.ownerSystem')}</>
  return <>{names.get(job.ownerUserId) ?? job.ownerUserId}</>
}

export function useInvalidateJobs(): () => void {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: [['jobs']] })
  }
}

/** Cancel (names the refusal when the producer says no), Dismiss and Open result. */
export function JobActions({ job }: { readonly job: Job }): ReactNode {
  const { t } = useTranslation()
  const showAlert = useAlert()
  const invalidate = useInvalidateJobs()
  const cancel = useJobsCancel({
    onSuccess: (res) => {
      invalidate()
      if (res.accepted) return
      void showAlert({
        title: t('activity.cancelRefused.title'),
        message: t(cancelRefusalKey(res.reason)),
      })
    },
  })
  const dismiss = useJobsDismiss({ onSuccess: invalidate })
  const collect = useJobsCollect({ jobId: job.jobId }, { enabled: job.state === 'done' })
  const result = collect.data ?? null
  return (
    <div className="flex items-center justify-end gap-1.5">
      {result !== null && (
        <AlertActionLink
          action={{
            label: t('activity.openResult'),
            href: result.href,
            ...(result.navigation !== undefined ? { navigation: result.navigation } : {}),
          }}
          className="inline-flex items-center rounded-md bg-primary px-2 py-0.5 text-[10px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        />
      )}
      {canCancelJob(job) && (
        <Button
          variant="outline"
          size="xs"
          disabled={cancel.isPending}
          onClick={() => cancel.mutate({ jobId: job.jobId })}
        >
          {cancel.isPending && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
          {t('activity.cancel')}
        </Button>
      )}
      {canDismissJob(job) && (
        <Button
          variant="ghost"
          size="xs"
          disabled={dismiss.isPending}
          onClick={() => dismiss.mutate({ jobId: job.jobId })}
          aria-label={t('activity.dismiss')}
          title={t('activity.dismiss')}
        >
          <X className="h-3 w-3" aria-hidden />
        </Button>
      )}
    </div>
  )
}
