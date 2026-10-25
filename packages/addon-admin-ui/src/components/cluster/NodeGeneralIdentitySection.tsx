/**
 * Nodes → General — operator-facing identity for a node: palette colour and
 * the LAN host cross-node decoders dial (same agent-settings record as Pipeline).
 */
import { useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { NodeColorIdSchema, type NodeColorId } from '@camstack/types'
import {
  Button,
  NODE_COLOR_IDS,
  SettingRow,
  assignNodeColorId,
  nodeColorClass,
  usePipelineOrchestratorListAgentSettings,
  usePipelineOrchestratorSetAgentReachableHost,
} from '@camstack/ui-library'
import {
  invalidatePlacementQueries,
  mutationErrorMessage,
  readObjectField,
  readStringObjectField,
  type ReachableHostSaveStatus,
} from '../pipeline/placement-board/board-model'
import { ReachableHostInput } from '../pipeline/placement-board/ReachableHostInput'

interface NodeGeneralIdentitySectionProps {
  readonly nodeId: string
  readonly detectedHosts: readonly string[]
}

function readNodeColorField(settings: object | undefined): NodeColorId | null {
  const parsed = NodeColorIdSchema.safeParse(readObjectField(settings, 'color'))
  return parsed.success ? parsed.data : null
}

function mutationStatusForNode(
  nodeId: string,
  mutation: {
    readonly variables?: { readonly agentNodeId?: string }
    readonly isPending: boolean
    readonly isError: boolean
    readonly isSuccess: boolean
  },
): ReachableHostSaveStatus {
  if (mutation.variables?.agentNodeId !== nodeId) return 'idle'
  if (mutation.isPending) return 'pending'
  if (mutation.isError) return 'error'
  if (mutation.isSuccess) return 'success'
  return 'idle'
}

export function NodeGeneralIdentitySection({
  nodeId,
  detectedHosts,
}: NodeGeneralIdentitySectionProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const settingsQuery = usePipelineOrchestratorListAgentSettings(undefined)
  // Two hook instances — host and colour share one cap method but must not
  // share pending UI (a host save must not disable the swatches).
  const saveReachableHost = usePipelineOrchestratorSetAgentReachableHost({
    onSuccess: () => invalidatePlacementQueries(queryClient),
  })
  const saveNodeColor = usePipelineOrchestratorSetAgentReachableHost({
    onSuccess: () => invalidatePlacementQueries(queryClient),
  })

  const settings = useMemo(
    () => settingsQuery.data?.find((row) => row.nodeId === nodeId)?.settings,
    [settingsQuery.data, nodeId],
  )

  const color =
    readNodeColorField(settings) ?? (settingsQuery.isLoading ? null : assignNodeColorId(nodeId))
  const reachableHost = readStringObjectField(settings, 'reachableHost')

  const hostSaveStatus = mutationStatusForNode(nodeId, saveReachableHost)
  const hostSaveError =
    hostSaveStatus === 'error' ? mutationErrorMessage(saveReachableHost.error) : null

  const ipv4Hosts = detectedHosts.filter((ip) => !ip.includes(':'))

  const handleColor = (next: NodeColorId): void => {
    if (next === color) return
    saveNodeColor.mutate({ agentNodeId: nodeId, color: next })
  }

  const handleReachableHost = (id: string, host: string | null): void => {
    saveReachableHost.mutate({ agentNodeId: id, reachableHost: host })
  }

  return (
    <div className="rounded-lg border border-border bg-surface/40 divide-y divide-border px-3">
      <SettingRow label={t('nodes.general.nodeColour', 'Node colour')}>
        <div
          role="group"
          aria-label={t('nodes.general.nodeColourGroup', 'Node colour')}
          className="flex flex-wrap gap-2"
        >
          {NODE_COLOR_IDS.map((id) => {
            const selected = color === id
            return (
              <Button
                key={id}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={id}
                variant="outline"
                size="sm"
                disabled={settingsQuery.isLoading || saveNodeColor.isPending}
                title={id}
                onClick={() => handleColor(id)}
                className={`h-6 w-6 min-w-6 shrink-0 rounded-full border-0 p-0 ${nodeColorClass(id)} ${
                  selected
                    ? 'ring-2 ring-primary ring-offset-2 ring-offset-background'
                    : 'opacity-80 hover:opacity-100'
                }`}
              >
                <span className="sr-only">{id}</span>
              </Button>
            )
          })}
        </div>
      </SettingRow>
      <SettingRow label={t('nodes.general.reachableHost', 'Reachable host')}>
        <ReachableHostInput
          nodeId={nodeId}
          value={reachableHost}
          detectedHosts={ipv4Hosts}
          status={hostSaveStatus}
          errorMessage={hostSaveError}
          onCommit={handleReachableHost}
        />
      </SettingRow>
    </div>
  )
}
