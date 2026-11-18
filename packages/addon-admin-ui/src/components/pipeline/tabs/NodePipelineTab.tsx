/**
 * Node → Pipeline: this node's base for every detection step (the step
 * matrix and its docked settings panel, D757), the cameras assigned to it,
 * and the node's reset.
 *
 * Accelerators themselves (on/off, share, cap) are edited in Cluster → Load
 * balancing — the inspector's summary line links there. Per-camera gates and
 * overrides live on each camera's Detection pipeline tab.
 */
import {
  Button,
  useConfirm,
  useClusterNodes,
  usePipelineOrchestratorResetNodePipelineDefaults,
} from '@camstack/ui-library'
import { useState } from 'react'

import { CameraStatusStrip } from '../CameraStatusStrip'
import { NodeStepInspector } from '../step-inspector/NodeStepInspector'
import { useTranslation } from 'react-i18next'

interface NodePipelineTabProps {
  readonly nodeId: string
  readonly refreshToken: number
}

export function NodePipelineTab({ nodeId, refreshToken: _refreshToken }: NodePipelineTabProps) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const [resetMessage, setResetMessage] = useState<string | null>(null)

  // Needs one node's NAME — the roster, not the diagram (D317).
  const { nodes: clusterNodes } = useClusterNodes()
  const nodeName = clusterNodes.find((n) => n.id === nodeId)?.name ?? nodeId

  // Reset this node's pipeline to hardware-aware defaults — the HONEST reset:
  // clears the node's per-(node,device) model bases (accelerators revert to
  // their format default), clears per-camera overrides scoped to this node +
  // the executor's per-device stores, hot-reloads assigned cameras, and returns
  // the EFFECTIVE post-reset detection model (what will actually run).
  const resetToDefault = usePipelineOrchestratorResetNodePipelineDefaults({
    onSuccess: (result) => {
      setResetMessage(
        result.effectiveModelId !== null
          ? `Reset done — effective detection model: ${result.effectiveModelId} (Auto)`
          : 'Reset done — model config cleared (node offline: effective model resolves on reconnect)',
      )
    },
  })

  const handleResetToDefault = async (): Promise<void> => {
    const confirmed = await confirm({
      title: t(
        'pipeline.nodePipelineTab.resetToHardwareAwareDefaults',
        'Reset {{nodeName}} to hardware-aware defaults?',
        { nodeName },
      ),
      message: t(
        'pipeline.nodePipelineTab.thisClearsEveryPerDevice',
        'This clears every per-device model default on this node (back to the format default) and every per-camera step override scoped to it. Existing per-camera customisations on this node are lost.',
      ),
      confirmLabel: t('common.reset', 'Reset'),
      variant: 'danger',
    })
    if (!confirmed) return
    setResetMessage(null)
    resetToDefault.mutate({ agentNodeId: nodeId })
  }

  return (
    <div className="space-y-2">
      <CameraStatusStrip nodeId={nodeId} />
      <NodeStepInspector
        nodeId={nodeId}
        nodeName={nodeName}
        toolbar={
          <>
            {resetMessage && <span className="text-[11px] text-success">{resetMessage}</span>}
            {resetToDefault.isError && (
              <span className="text-[11px] text-danger">
                {resetToDefault.error instanceof Error
                  ? resetToDefault.error.message
                  : t('pipeline.nodePipelineTab.resetFailed', 'Reset failed')}
              </span>
            )}
            {/* Destructive: clears model config + per-camera overrides scoped to the node. */}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void handleResetToDefault()
              }}
              disabled={resetToDefault.isPending}
              title={t(
                'pipeline.nodePipelineTab.clearThisNodeSPer',
                "Clear this node's per-device model defaults + per-camera overrides scoped to this node",
              )}
            >
              {resetToDefault.isPending
                ? t('pipeline.nodePipelineTab.resetting', 'Resetting…')
                : t('pipeline.nodePipelineTab.resetToDefault', 'Reset to default')}
            </Button>
          </>
        }
      />
    </div>
  )
}
