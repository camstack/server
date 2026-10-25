/**
 * Selected job detail under the Jobs table: timeline, progress, log and
 * result actions. Cancel lives on the table row.
 */
import { useEffect, useRef } from 'react'
import type { TrainingJob } from '@camstack/types'
import { Badge, type AddonPageProps } from '@camstack/ui-library'
import { useT } from '../i18n/index.js'
import { ResultPanel } from './ResultPanel.js'
import { Sparkline } from './Sparkline.js'
import {
  elapsedSec,
  formatCost,
  formatDuration,
  isSettled,
  stateTone,
  timelineSteps,
} from './view-model.js'

export interface JobDetailProps {
  readonly job: TrainingJob
  readonly trpc: AddonPageProps['trpc']
  readonly onChanged: () => void
  readonly cameraName: (id: number) => string
  readonly collectionName: (id: string) => string
}

const STEP_CLASS = {
  done: 'bg-primary/15 text-primary',
  current: 'bg-primary text-primary-foreground',
  failed: 'bg-danger text-white',
  todo: 'bg-surface-hover text-foreground-subtle',
} as const

function LogTail({ lines }: { readonly lines: readonly string[] }) {
  const ref = useRef<HTMLPreElement>(null)
  useEffect(() => {
    if (ref.current !== null) ref.current.scrollTop = ref.current.scrollHeight
  }, [lines])
  if (lines.length === 0) return null
  return (
    <pre
      ref={ref}
      className="max-h-48 overflow-auto rounded-md bg-surface-hover p-2 font-mono text-xs text-foreground-muted"
      data-testid="log-tail"
    >
      {lines.join('\n')}
    </pre>
  )
}

export function JobDetail({ job, trpc, onChanged, cameraName, collectionName }: JobDetailProps) {
  const { t, lang } = useT()
  const elapsed = elapsedSec(job, Date.now())
  const { epoch, epochs, etaSec, series } = job.progress
  const hasResult = job.state === 'ready' || job.state === 'registered' || job.state === 'canary'
  const costSummary: string[] = []
  if (elapsed !== null) costSummary.push(t('jobDetail.ran', { duration: formatDuration(elapsed) }))
  costSummary.push(
    t('jobDetail.cost', {
      cost: formatCost(job.provider.costUsd, job.provider.costIsEstimate),
      cap: job.maxCostUsd.toFixed(2),
    }),
  )
  if (job.cloudDatasetDeletedAt !== null) {
    costSummary.push(
      t('jobDetail.datasetDeleted', {
        when: new Date(job.cloudDatasetDeletedAt).toLocaleString(lang),
      }),
    )
  } else if (job.cloudCleanupDueAt !== null) {
    costSummary.push(
      t('jobDetail.datasetKept', { when: new Date(job.cloudCleanupDueAt).toLocaleString(lang) }),
    )
  }
  if (job.artifacts !== null) {
    costSummary.push(
      t('jobDetail.resultKept', {
        when: new Date(job.artifacts.expiresAt).toLocaleDateString(lang),
      }),
    )
  }
  const collectionLabels = job.request.selection.collectionIds.map((id) => collectionName(id))

  return (
    <section
      className="space-y-3 rounded-lg border border-border bg-surface p-3 sm:p-4"
      data-testid={`job-detail-${job.id}`}
      aria-label={t('jobDetail.details', { name: job.name })}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-foreground">{job.name}</span>
        <Badge variant={stateTone(job.state)}>{t(`state.${job.state}`)}</Badge>
        {job.stage !== null && !isSettled(job.state) && <Badge variant="info">{job.stage}</Badge>}
        <span className="text-xs text-foreground-subtle">
          {job.request.baseModelId} · {job.request.gpuType} ·{' '}
          {new Date(job.createdAt).toLocaleString(lang)}
        </span>
      </div>
      <p className="text-xs text-foreground-muted" data-testid={`job-detail-collections-${job.id}`}>
        {t('jobDetail.collections')}{' '}
        {collectionLabels.length > 0 ? collectionLabels.join(', ') : '—'}
      </p>
      <ol className="flex flex-wrap gap-1" aria-label={t('jobDetail.progress')}>
        {timelineSteps(job).map((s) => (
          <li
            key={s.state}
            className={`rounded-full px-2 py-0.5 text-xs ${STEP_CLASS[s.status]}`}
            aria-current={s.status === 'current' ? 'step' : undefined}
          >
            {s.status === 'failed'
              ? t('jobDetail.stepFailed', {
                  step: t(`state.${s.state}`),
                  state: t(`state.${job.state}`),
                })
              : t(`state.${s.state}`)}
          </li>
        ))}
      </ol>
      {job.failure !== null && (
        <p className="text-sm text-danger" role="alert">
          {job.failure.stage !== null
            ? t('jobDetail.failureDuring', {
                reason: job.failure.reason,
                stage: job.failure.stage,
                detail: job.failure.detail,
              })
            : t('jobDetail.failure', { reason: job.failure.reason, detail: job.failure.detail })}
        </p>
      )}
      {epoch !== null && epochs !== null && (
        <div className="space-y-1">
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-surface-hover"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={epochs}
            aria-valuenow={epoch}
          >
            <div
              className="h-full bg-primary"
              // ui-check-ok: computed progress width % (geometry only)
              style={{ width: `${String(Math.min(100, (epoch / Math.max(1, epochs)) * 100))}%` }}
            />
          </div>
          <span className="text-xs text-foreground-muted">
            {t('jobDetail.epoch', { epoch, epochs })}
            {etaSec !== null && !isSettled(job.state)
              ? ` · ${t('jobDetail.eta', { duration: formatDuration(etaSec) })}`
              : ''}
          </span>
        </div>
      )}
      <Sparkline series={series} />
      <p className="text-xs text-foreground-muted">{costSummary.join(' · ')}</p>
      <LogTail lines={job.logTail} />
      {hasResult && (
        <ResultPanel job={job} trpc={trpc} onChanged={onChanged} cameraName={cameraName} />
      )}
    </section>
  )
}
