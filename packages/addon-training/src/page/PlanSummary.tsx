/** The planner's answer: split, estimate, warnings, refusal. Read-only. */
import type { TrainingJobPlan } from '@camstack/types'
import { Trans, useT } from '../i18n/index.js'
import { formatBytes, formatDuration } from './view-model.js'

export function PlanSummary({
  plan,
  cameraName,
}: {
  readonly plan: TrainingJobPlan
  readonly cameraName: (id: number) => string
}) {
  const { t } = useT()
  const { split, estimate } = plan
  const holdoutScope =
    split !== null && split.holdoutCameras.length > 0
      ? split.holdoutCameras.map(cameraName).join(', ')
      : t('plan.lastDays', { days: split?.holdoutLastDays ?? 0 })
  return (
    <div className="space-y-2 text-sm" data-testid="plan-summary">
      {plan.refusal !== null && (
        <p className="rounded-md bg-danger/15 p-2 text-danger" role="alert">
          {t('plan.cannotStart', { reason: plan.refusal.reason, detail: plan.refusal.detail })}
        </p>
      )}
      {split !== null && (
        <p className="text-foreground-muted">
          {split.holdoutSupport !== null
            ? t('plan.heldOutWithSupport', {
                scope: holdoutScope,
                support: Object.entries(split.holdoutSupport)
                  .map(([cls, n]) => `${cls} ${String(n)}`)
                  .join(', '),
                train: split.trainSubjects,
              })
            : t('plan.heldOut', { scope: holdoutScope, train: split.trainSubjects })}
        </p>
      )}
      {estimate !== null && (
        <div className="grid gap-1 text-foreground-muted sm:grid-cols-2">
          <span>
            <Trans
              i18nKey="plan.estimatedCost"
              values={{ low: estimate.usdLow.toFixed(2), high: estimate.usdHigh.toFixed(2) }}
              components={{ b: <span className="font-medium text-foreground" /> }}
            />
          </span>
          <span>
            {t('plan.gpuTime', {
              low: formatDuration(estimate.gpuSecondsLow),
              high: formatDuration(estimate.gpuSecondsHigh),
            })}
          </span>
          <span>
            {t('plan.upload', {
              size: formatBytes(estimate.datasetBytes),
              minutes: estimate.uploadMinutesAt20Mbps,
            })}
          </span>
        </div>
      )}
      {estimate?.notes.map((n) => (
        <p key={n} className="text-xs text-foreground-subtle">
          {n}
        </p>
      ))}
      {plan.warnings.map((w) => (
        <p key={w} className="text-xs text-warning">
          {w}
        </p>
      ))}
    </div>
  )
}
