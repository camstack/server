import type { JSX } from 'react'
import type { ClusterUpdateStep, ClusterUpdateStepStatus } from '@camstack/types'
import { StatusBadge } from '@camstack/ui-library'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { stepMark } from '../../lib/cluster-update-view'

export interface ClusterUpdateStepsProps {
  readonly steps: readonly ClusterUpdateStep[]
  readonly restarting: boolean
  readonly targetVersion: string | null
  readonly skippedOffline: readonly string[]
}

/** One row per step of the hub's job: status, where, the server's line, the typed reason. */
export function ClusterUpdateSteps({
  steps,
  restarting,
  targetVersion,
  skippedOffline,
}: ClusterUpdateStepsProps): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-2">
      {targetVersion !== null && targetVersion !== '' && (
        <p className="text-xs text-foreground-muted">
          {t('clusterUpdate.target', {
            defaultValue: 'Target {{version}}',
            version: targetVersion,
          })}
        </p>
      )}
      {restarting && (
        <p role="status" className="text-xs text-warning">
          {t(
            'clusterUpdate.restarting',
            'The hub is restarting. Progress resumes when it answers.',
          )}
        </p>
      )}
      <ul
        aria-label={t('clusterUpdate.stepsLabel', 'Cluster update steps')}
        className="flex flex-col gap-1"
      >
        {steps.map((step, index) => (
          <StepRow key={stepKey(step, index)} step={step} />
        ))}
      </ul>
      {skippedOffline.length > 0 && (
        <p className="text-xs text-foreground-subtle">
          {t('clusterUpdate.offline', {
            defaultValue: 'Offline, not updated: {{nodes}}',
            nodes: skippedOffline.join(', '),
          })}
        </p>
      )}
    </div>
  )
}

function stepKey(step: ClusterUpdateStep, index: number): string {
  return `${index}:${step.kind}:${step.nodeId ?? ''}`
}

interface StepRowProps {
  readonly step: ClusterUpdateStep
}

function StepRow({ step }: StepRowProps): JSX.Element {
  const { t } = useTranslation()
  return (
    <li
      data-status={step.status}
      data-kind={step.kind}
      {...(step.reason !== undefined ? { 'data-reason': step.reason } : {})}
      className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded border border-border bg-surface px-2 py-1 text-xs"
    >
      <StatusBadge status={stepMark(step.status)} label={statusLabel(step.status, t)} />
      <span className="font-medium text-foreground">{stepLabel(step, t)}</span>
      <span className="text-foreground-muted">{step.detail}</span>
      {step.reason !== undefined && (
        <span className="text-danger">{t(`clusterUpdate.reason.${step.reason}`)}</span>
      )}
    </li>
  )
}

function stepLabel(step: ClusterUpdateStep, t: TFunction): string {
  const name = String(t(`clusterUpdate.step.${step.kind}`, { defaultValue: step.kind }))
  return step.nodeId !== undefined ? `${name} · ${step.nodeId}` : name
}

function statusLabel(status: ClusterUpdateStepStatus, t: TFunction): string {
  return String(t(`clusterUpdate.status.${status}`, { defaultValue: status }))
}
