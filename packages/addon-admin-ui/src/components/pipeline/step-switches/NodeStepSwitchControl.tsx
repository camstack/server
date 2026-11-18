/**
 * One step's NODE switch and its effective result: the switch (off writes
 * `false`, on writes `null` = inherit), disabled while the cluster holds the
 * step off, and the `StepEffectLabel`. A node the matrix does not list draws no
 * switch — its stored value is unknown, and an unknown is never an unchecked
 * switch.
 */
import { Switch } from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'
import { StepEffectLabel } from './StepEffectLabel'
import { findNode, heldOffBy, nodeEffect, type StepSwitchRow } from './step-switches-model'
import type { StepSwitchWriters } from './use-step-switches'

interface NodeStepSwitchControlProps {
  readonly row: StepSwitchRow
  readonly nodeId: string
  readonly writers: StepSwitchWriters
}

export function NodeStepSwitchControl({ row, nodeId, writers }: NodeStepSwitchControlProps) {
  const { t } = useTranslation()
  const node = findNode(row, nodeId)
  const effect = node === undefined ? null : nodeEffect(node)
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {node !== undefined && (
        <Switch
          checked={node.stepEnabled !== false}
          disabled={heldOffBy(effect, 'node') !== null || writers.isPending}
          onCheckedChange={(on) => writers.setNodeEnabled(nodeId, row.stepId, on ? null : false)}
          aria-label={t('pipeline.stepSwitches.nodeToggle', 'Run {{step}} on this node', {
            step: row.name,
          })}
        />
      )}
      <StepEffectLabel
        ownLevel="node"
        effect={effect}
        {...(node !== undefined && !node.reachable
          ? {
              unknownHint: t('pipeline.stepSwitches.state.nodeSilent', 'Node not answering'),
            }
          : {})}
      />
    </div>
  )
}
