/**
 * One accelerator's step switches, shown under its row in the node's
 * accelerator table: a toggle per step (`setDeviceStepEnabled`) and the
 * effective result on this device with the level that turned it off. Off means
 * the device never runs the step — a detail step moves to an allowed sibling
 * when there is one, which the result says ("Runs on …").
 *
 * `view` is the shared matrix query; while it is pending or failed the rows
 * say so instead of drawing every step as off.
 */
import { ErrorBox, Skeleton, Switch, TEXT_HINT } from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'
import { StepEffectLabel } from './StepEffectLabel'
import { deviceEffect, deviceStepRows, heldOffBy } from './step-switches-model'
import type { StepSwitchesView, StepSwitchWriters } from './use-step-switches'

interface DeviceStepSwitchesProps {
  readonly nodeId: string
  readonly deviceKey: string
  readonly view: StepSwitchesView
  readonly writers: StepSwitchWriters
}

export function DeviceStepSwitches({ nodeId, deviceKey, view, writers }: DeviceStepSwitchesProps) {
  const { t } = useTranslation()
  if (view.status === 'pending') return <Skeleton className="h-10 w-full" />
  if (view.status === 'error') {
    return (
      <ErrorBox
        title={t('pipeline.stepSwitches.loadFailed', 'Step switches did not load')}
        message={view.message}
      />
    )
  }
  const steps = deviceStepRows(view.rows, nodeId, deviceKey)
  if (steps.length === 0) {
    return (
      <p className={TEXT_HINT}>
        {t(
          'pipeline.stepSwitches.deviceNoSteps',
          'The orchestrator has no step answer for this accelerator yet.',
        )}
      </p>
    )
  }
  return (
    <div className="space-y-2">
      {writers.error !== null && (
        <ErrorBox
          title={t('pipeline.stepSwitches.writeFailed', 'The change was not saved')}
          message={writers.error}
        />
      )}
      <ul className="grid gap-x-6 gap-y-1.5 md:grid-cols-2">
        {steps.map((step) => (
          <li key={step.stepId} className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Switch
              checked={step.device.stepEnabled !== false}
              disabled={
                heldOffBy(deviceEffect(step.device), 'device') !== null || writers.isPending
              }
              onCheckedChange={(on) =>
                writers.setDeviceEnabled(nodeId, deviceKey, step.stepId, on ? null : false)
              }
              aria-label={t(
                'pipeline.stepSwitches.deviceToggle',
                'Run {{step}} on this accelerator',
                {
                  step: step.name,
                },
              )}
            />
            <span className="text-xs text-foreground">{step.name}</span>
            <StepEffectLabel ownLevel="device" effect={deviceEffect(step.device)} />
          </li>
        ))}
      </ul>
    </div>
  )
}
