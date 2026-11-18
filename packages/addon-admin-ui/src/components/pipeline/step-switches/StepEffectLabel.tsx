/**
 * The effective result of a step on one node or accelerator, and — when it is
 * off — which level turned it off. Shared by the cluster, node and accelerator
 * controls so the three say the same thing. `unknown` renders as its own
 * neutral dashed badge: a matrix that did not answer is never drawn as "off".
 */
import { Badge } from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'
import type { OffLevel, StepEffect } from './step-switches-model'

const OFF_REASON: Readonly<Record<OffLevel, readonly [string, string]>> = {
  cluster: ['pipeline.stepSwitches.reason.cluster', 'Off for the whole cluster'],
  node: ['pipeline.stepSwitches.reason.node', 'Off on this node'],
  device: ['pipeline.stepSwitches.reason.device', 'Off on this accelerator'],
  'opt-in': ['pipeline.stepSwitches.reason.optIn', 'Opt-in: no camera has turned it on'],
  model: ['pipeline.stepSwitches.reason.model', 'No build of it fits this node'],
}

interface StepEffectLabelProps {
  /** `null` while the matrix has not answered. */
  readonly effect: StepEffect | null
  /** Names the unknown case: the node did not answer vs the query is still loading. */
  readonly unknownHint?: string
}

export function StepEffectLabel({ effect, unknownHint }: StepEffectLabelProps) {
  const { t } = useTranslation()
  if (effect === null || effect.state === 'unknown') {
    return (
      <Badge variant="neutral" dashed style="outline" size="sm">
        {unknownHint ?? t('pipeline.stepSwitches.state.unknown', 'Not known yet')}
      </Badge>
    )
  }
  if (effect.state === 'off') {
    const [key, fallback] = OFF_REASON[effect.level]
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <Badge variant="warning" size="sm">
          {t('pipeline.stepSwitches.state.off', 'Off')}
        </Badge>
        <span className="text-[11px] text-foreground-muted">{t(key, fallback)}</span>
      </span>
    )
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Badge variant="success" size="sm">
        {t('pipeline.stepSwitches.state.on', 'On')}
      </Badge>
      {effect.via === 'jump' && effect.toDeviceKey !== undefined && (
        <span className="text-[11px] text-foreground-muted">
          {t('pipeline.stepSwitches.via.jump', 'Runs on {{device}}', {
            device: effect.toDeviceKey,
          })}
        </span>
      )}
      {effect.via === 'root' && (
        <span className="text-[11px] text-foreground-muted">
          {t('pipeline.stepSwitches.via.root', 'Supplied by the root model')}
        </span>
      )}
      {effect.via === 'zone' && (
        <span className="text-[11px] text-foreground-muted">
          {t('pipeline.stepSwitches.via.zone', 'Runs where a zone is drawn')}
        </span>
      )}
    </span>
  )
}
