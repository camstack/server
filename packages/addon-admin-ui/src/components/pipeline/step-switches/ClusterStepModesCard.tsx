/**
 * Cluster → Settings → Step switches: one mode selector per pipeline step —
 * off (no camera, node or accelerator can run it), on (runs unless a camera
 * turns it off) and opt-in (runs only on cameras that turn it on). It writes
 * the orchestrator's cluster mode (`setClusterStepMode`) and stores nothing of
 * its own.
 *
 * Next to each selector: the mode in force, how many cameras turn the step on
 * or off, and on how many nodes it actually runs. Which cameras re-attach after
 * a change is not part of the matrix, so it is not shown.
 */
import { Select, SettingRow } from '@camstack/ui-library'
import { type StepClusterMode, StepClusterModeSchema } from '@camstack/types'
import { ToggleLeft } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { StepSwitchesFrame } from './StepSwitchesFrame'
import { nodeEffect, type StepSwitchRow } from './step-switches-model'
import { useStepSwitches, useStepSwitchWriters } from './use-step-switches'

const DEFAULT_VALUE = ''

function nodeCounts(row: StepSwitchRow): { readonly running: number; readonly known: number } {
  const effects = row.nodes.map(nodeEffect).filter((e) => e.state !== 'unknown')
  return { running: effects.filter((e) => e.state === 'on').length, known: effects.length }
}

interface ModeRowProps {
  readonly row: StepSwitchRow
  readonly disabled: boolean
  readonly onChange: (stepId: string, mode: StepClusterMode | null) => void
}

function ModeRow({ row, disabled, onChange }: ModeRowProps) {
  const { t } = useTranslation()
  const modeLabel: Readonly<Record<StepClusterMode, string>> = {
    off: t('pipeline.stepSwitches.mode.off', 'Off'),
    on: t('pipeline.stepSwitches.mode.on', 'On'),
    'opt-in': t('pipeline.stepSwitches.mode.optIn', 'Opt-in'),
  }
  const { running, known } = nodeCounts(row)
  return (
    <SettingRow label={row.name}>
      <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
        <Select
          aria-label={t('pipeline.stepSwitches.clusterModeFor', 'Cluster mode for {{step}}', {
            step: row.name,
          })}
          wrapperClassName="relative w-full sm:w-44"
          value={row.clusterMode ?? DEFAULT_VALUE}
          disabled={disabled}
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
            onChange(row.stepId, parsed.success ? parsed.data : null)
          }}
        />
        <span className="text-[11px] text-foreground-muted">
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
        </span>
      </div>
    </SettingRow>
  )
}

export function ClusterStepModesCard() {
  const { t } = useTranslation()
  const view = useStepSwitches(t('pipeline.stepSwitches.loadFailed', 'Step switches did not load'))
  const writers = useStepSwitchWriters(
    t('pipeline.stepSwitches.writeFailed', 'The change was not saved'),
  )
  return (
    <StepSwitchesFrame
      headingId="cluster-step-switches"
      title={t('pipeline.stepSwitches.clusterTitle', 'Step switches')}
      icon={ToggleLeft}
      hint={t(
        'pipeline.stepSwitches.clusterHint',
        'Off turns a step off for every camera. On runs it unless a camera turns it off. Opt-in runs it only on cameras that turn it on. A node or accelerator switch can still turn it off below that.',
      )}
      view={view}
      writeError={writers.error}
    >
      {(rows) => (
        <div className="space-y-1">
          {rows.map((row) => (
            <ModeRow
              key={row.stepId}
              row={row}
              disabled={writers.isPending}
              onChange={writers.setClusterMode}
            />
          ))}
        </div>
      )}
    </StepSwitchesFrame>
  )
}
