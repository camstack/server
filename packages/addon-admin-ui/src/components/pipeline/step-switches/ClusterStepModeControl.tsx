/**
 * One step's CLUSTER mode — off (no camera, node or accelerator can run it),
 * on (runs unless a camera turns it off) or opt-in (runs only on cameras that
 * turn it on) — with the mode in force, how many cameras turn the step on or
 * off, and on how many nodes it actually runs. It writes the orchestrator's
 * cluster mode (`setClusterStepMode`); `Default` writes `null`.
 */
import { Select } from '@dominevo/ui-library'
import { type StepClusterMode, StepClusterModeSchema } from '@dominevo/types'
import { useTranslation } from 'react-i18next'
import { nodeEffect, type StepSwitchRow } from './step-switches-model'
import type { StepSwitchWriters } from './use-step-switches'

const DEFAULT_VALUE = ''

function nodeCounts(row: StepSwitchRow): {
  readonly running: number
  readonly known: number
} {
  const effects = row.nodes.map(nodeEffect).filter((e) => e.state !== 'unknown')
  return {
    running: effects.filter((e) => e.state === 'on').length,
    known: effects.length,
  }
}

interface ClusterStepModeControlProps {
  readonly row: StepSwitchRow
  readonly writers: StepSwitchWriters
}

export function ClusterStepModeControl({ row, writers }: ClusterStepModeControlProps) {
  const { t } = useTranslation()
  const modeLabel: Readonly<Record<StepClusterMode, string>> = {
    off: t('pipeline.stepSwitches.mode.off', 'Off'),
    on: t('pipeline.stepSwitches.mode.on', 'On'),
    'opt-in': t('pipeline.stepSwitches.mode.optIn', 'Opt-in'),
  }
  const { running, known } = nodeCounts(row)
  return (
    <div className="space-y-1">
      <Select
        aria-label={t('pipeline.stepSwitches.clusterModeFor', 'Cluster mode for {{step}}', {
          step: row.name,
        })}
        wrapperClassName="relative w-full max-w-44"
        value={row.clusterMode ?? DEFAULT_VALUE}
        disabled={writers.isPending}
        options={[
          {
            value: DEFAULT_VALUE,
            label: t('pipeline.stepSwitches.mode.default', 'Default ({{mode}})', {
              mode: modeLabel[row.effectiveMode],
            }),
          },
          { value: 'on', label: modeLabel.on },
          { value: 'opt-in', label: modeLabel['opt-in'] },
          { value: 'off', label: modeLabel.off },
        ]}
        onChange={(e) => {
          const parsed = StepClusterModeSchema.safeParse(e.target.value)
          writers.setClusterMode(row.stepId, parsed.success ? parsed.data : null)
        }}
      />
      <p className="text-[11px] text-foreground-muted">
        {row.effectiveMode === 'off'
          ? t('pipeline.stepSwitches.cluster.hardOff', 'Off everywhere: no camera can turn it on')
          : t('pipeline.stepSwitches.cluster.cameras', {
              defaultValue:
                'Cameras: {{enabling}} turn it on, {{disabling}} turn it off · runs on {{running}} of {{known}} nodes',
              enabling: row.camerasEnabling,
              disabling: row.camerasDisabling,
              running,
              known,
            })}
      </p>
    </div>
  )
}
