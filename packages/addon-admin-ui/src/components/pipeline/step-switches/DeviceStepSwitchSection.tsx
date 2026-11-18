/**
 * The clicked accelerator's own switch for the open step (`setDeviceStepEnabled`)
 * and its effective result. Off means this device never runs the step — a detail
 * step moves to an allowed sibling when there is one, which the result says
 * ("Runs on …"). Held off above (cluster or node) keeps the switch, disabled.
 * Draws nothing for a step with no switch row, or while the matrix has no answer.
 */
import { Switch, TEXT_SECTION_LABEL } from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'
import { StepEffectLabel } from './StepEffectLabel'
import { deviceEffect, findDevice, heldOffBy } from './step-switches-model'
import type { StepSwitchesView, StepSwitchWriters } from './use-step-switches'

interface DeviceStepSwitchSectionProps {
  readonly nodeId: string
  readonly deviceKey: string
  readonly stepId: string
  readonly view: StepSwitchesView
  readonly writers: StepSwitchWriters
}

export function DeviceStepSwitchSection({
  nodeId,
  deviceKey,
  stepId,
  view,
  writers,
}: DeviceStepSwitchSectionProps) {
  const { t } = useTranslation()
  if (view.status !== 'ready') return null
  const row = view.rows.find((r) => r.stepId === stepId)
  const device = row === undefined ? undefined : findDevice(row, nodeId, deviceKey)
  if (row === undefined || device === undefined) return null
  const effect = deviceEffect(device)
  const heading = t('pipeline.stepSwitches.deviceSection', 'Accelerator switch')
  return (
    <section className="space-y-2" aria-label={heading}>
      <h3 className={TEXT_SECTION_LABEL}>{heading}</h3>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Switch
          checked={device.stepEnabled !== false}
          disabled={heldOffBy(effect, 'device') !== null || writers.isPending}
          onCheckedChange={(on) =>
            writers.setDeviceEnabled(nodeId, deviceKey, stepId, on ? null : false)
          }
          aria-label={t('pipeline.stepSwitches.deviceToggle', 'Run {{step}} on this accelerator', {
            step: row.name,
          })}
        />
        <StepEffectLabel ownLevel="device" effect={effect} />
      </div>
    </section>
  )
}
