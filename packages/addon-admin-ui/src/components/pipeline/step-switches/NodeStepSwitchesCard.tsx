/**
 * Node → Pipeline → Step switches: one enable toggle per step for this node.
 * Off (`setNodeStepEnabled(false)`) means no camera whose pipeline runs here
 * runs the step; on clears the switch back to inherit (`null`), so a cluster
 * `off` still reads as off — with its reason — rather than being hidden by a
 * stored `true`.
 *
 * The toggle is the node's own switch; the badge beside it is the effective
 * result the orchestrator computed for this node.
 */
import { SettingRow, Switch } from '@camstack/ui-library'
import { ToggleLeft } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { StepEffectLabel } from './StepEffectLabel'
import { StepSwitchesFrame } from './StepSwitchesFrame'
import { findNode, nodeEffect } from './step-switches-model'
import { useStepSwitches, useStepSwitchWriters } from './use-step-switches'

interface NodeStepSwitchesCardProps {
  readonly nodeId: string
}

export function NodeStepSwitchesCard({ nodeId }: NodeStepSwitchesCardProps) {
  const { t } = useTranslation()
  const view = useStepSwitches(t('pipeline.stepSwitches.loadFailed', 'Step switches did not load'))
  const writers = useStepSwitchWriters(
    t('pipeline.stepSwitches.writeFailed', 'The change was not saved'),
  )
  return (
    <StepSwitchesFrame
      headingId={`node-step-switches-${nodeId}`}
      title={t('pipeline.stepSwitches.nodeTitle', 'Step switches')}
      icon={ToggleLeft}
      hint={t(
        'pipeline.stepSwitches.nodeHint',
        'Turn a step off to skip it for every camera running on this node. The cluster switch above it and the accelerator switch below it can also turn it off; the result shows which.',
      )}
      view={view}
      writeError={writers.error}
    >
      {(rows) => (
        <div className="space-y-1">
          {rows.map((row) => {
            const node = findNode(row, nodeId)
            return (
              <SettingRow key={row.stepId} label={row.name}>
                <div className="flex flex-wrap items-center gap-3">
                  <Switch
                    checked={node === undefined ? false : node.stepEnabled !== false}
                    disabled={node === undefined || writers.isPending}
                    onCheckedChange={(on) =>
                      writers.setNodeEnabled(nodeId, row.stepId, on ? null : false)
                    }
                    aria-label={t('pipeline.stepSwitches.nodeToggle', 'Run {{step}} on this node', {
                      step: row.name,
                    })}
                  />
                  <StepEffectLabel
                    effect={node === undefined ? null : nodeEffect(node)}
                    {...(node !== undefined && !node.reachable
                      ? {
                          unknownHint: t(
                            'pipeline.stepSwitches.state.nodeSilent',
                            'Node not answering',
                          ),
                        }
                      : {})}
                  />
                </div>
              </SettingRow>
            )
          })}
        </div>
      )}
    </StepSwitchesFrame>
  )
}
