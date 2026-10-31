/**
 * NodeList — left rail of the Pipeline page.
 *
 * Top entry: the synthetic "Cluster" row that switches the right pane to
 * orchestrator-global settings (assignments, balancer thresholds, failover
 * policy).
 *
 * Followed by one row per top-level cluster node (hub + online agents)
 * sourced from the existing `nodes.topology` tRPC query — same data source
 * as the Cluster page, no duplication.
 */

import {
  Badge,
  formatLastSeen,
  useClusterTopology,
  usePipelineOrchestratorGetPipelineAssignments,
  usePipelineOrchestratorListAgentSettings,
  useUiText,
  Button,
} from '@camstack/ui-library'
import { Cpu, Globe, Server, Video } from 'lucide-react'
import { lastSeenToMs } from '../../lib/last-seen'
import { CLUSTER_NODE_ID } from '../../pages/Pipeline'
import { concernEnablement } from './lib/node-enablement'
import { useTranslation } from 'react-i18next'

interface NodeListProps {
  readonly selectedNodeId: string
  readonly onSelect: (nodeId: string) => void
  readonly refreshToken: number
}

interface AssignmentCount {
  readonly agentNodeId: string
  readonly pinned: boolean
}

export function NodeList({ selectedNodeId, onSelect, refreshToken: _refreshToken }: NodeListProps) {
  const uiText = useUiText()
  const { t } = useTranslation()
  // Node cards render cores / RAM / lastSeen, which live only on the full
  // topology row — a sanctioned diagram reader, through the hook (D317).
  const { nodes: topology } = useClusterTopology()
  const { data: assignments } = usePipelineOrchestratorGetPipelineAssignments(undefined)

  // Single read of per-node orchestrator capability records for the display
  // pills. Unset flags inherit the orchestrator default: hub=true, agents=false.
  const { data: agentSettings } = usePipelineOrchestratorListAgentSettings(undefined)

  // Count cameras assigned to each agent for the node badge.
  const cameraCountByAgent = new Map<string, number>()
  for (const a of (assignments ?? []) as readonly AssignmentCount[]) {
    cameraCountByAgent.set(a.agentNodeId, (cameraCountByAgent.get(a.agentNodeId) ?? 0) + 1)
  }

  const nodes = topology ?? []
  const onlineCount = nodes.filter((n) => n.isOnline).length
  const offlineCount = nodes.filter((n) => !n.isOnline).length

  return (
    <div className="flex flex-col h-full">
      {/* Synthetic Cluster entry */}
      <Button
        variant="unstyled"
        type="button"
        onClick={() => onSelect(CLUSTER_NODE_ID)}
        className={`flex items-center gap-3 px-4 py-3 border-b border-border text-left transition-colors ${
          selectedNodeId === CLUSTER_NODE_ID
            ? 'bg-primary/10 text-primary'
            : 'text-foreground hover:bg-surface-hover'
        }`}
      >
        <Globe className="h-4 w-4 flex-shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold truncate">
            {t('pipeline.nodeList.cluster', 'Cluster')}
          </div>
          <div className="text-[10px] text-foreground-subtle">
            {t(
              'pipeline.nodeList.assignmentsLoadBalancingRoles',
              'Assignments, load balancing, roles',
            )}
          </div>
        </div>
      </Button>

      {/* Node rows */}
      <div className="flex-1 overflow-y-auto">
        {nodes.map((node) => {
          const isSelected = selectedNodeId === node.id
          const cameras = cameraCountByAgent.get(node.id) ?? 0
          const Icon = node.isHub ? Server : Cpu
          // Which pipeline concerns actually run on this node (detection /
          // audio). Optimistic green while settings load. Decode has no pill:
          // it is always co-located with detection (detect ⇒ decode).
          const enablement = concernEnablement(agentSettings, node.id)
          const relativeLastSeen = node.isOnline
            ? null
            : formatLastSeen(lastSeenToMs(node.lastSeen), uiText)
          return (
            <Button
              variant="unstyled"
              key={node.id}
              type="button"
              onClick={() => onSelect(node.id)}
              className={`flex items-center gap-3 w-full px-4 py-3 border-b border-border text-left transition-colors ${
                isSelected ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-surface-hover'
              }${node.isOnline ? '' : ' opacity-60'}`}
            >
              <Icon className="h-4 w-4 flex-shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold truncate">{node.name}</span>
                  {node.isHub && (
                    <span className="text-[9px] uppercase tracking-wider text-foreground-subtle border border-border rounded px-1 py-0.5">
                      {t('common.hubWord')}
                    </span>
                  )}
                  {!node.isOnline && (
                    <span className="h-1.5 w-1.5 rounded-full bg-danger flex-shrink-0" />
                  )}
                  {node.isOnline && (
                    <span className="h-1.5 w-1.5 rounded-full bg-success flex-shrink-0" />
                  )}
                </div>
                <div className="text-[10px] text-foreground-subtle flex items-center gap-2 mt-0.5">
                  <span>{t('common.coresCount', { count: node.cpuCores })}</span>
                  <span>•</span>
                  <span>{Math.round(node.memoryMB / 1024)} GB</span>
                  {cameras > 0 && (
                    <>
                      <span>•</span>
                      <span className="inline-flex items-center gap-0.5 text-foreground">
                        <Video className="h-2.5 w-2.5" />
                        {cameras}
                      </span>
                    </>
                  )}
                  {!node.isOnline && (
                    <>
                      <span>•</span>
                      <span className="text-danger">
                        {t('common.offline')}
                        {relativeLastSeen !== null ? ` · ${relativeLastSeen}` : ''}
                      </span>
                    </>
                  )}
                </div>
                {/* Per-concern enablement pills — display-only. Green when
                    the node is in the concern's whitelist, red otherwise. */}
                <div className="mt-0.5 flex items-center gap-1">
                  <Badge
                    variant={enablement.pipeline ? 'success' : 'danger'}
                    className="px-1 py-0 text-[9px] leading-3"
                    title={
                      enablement.pipeline
                        ? t('pipeline.nodeList.pipelineEnabled', 'Pipeline: enabled')
                        : t(
                            'pipeline.nodeList.pipelineNotEnabledAgentCapability',
                            'Pipeline: not enabled (agent capability)',
                          )
                    }
                  >
                    {t('pipeline.nodeList.pipe', 'Pipe')}
                  </Badge>
                  <Badge
                    variant={enablement.audio ? 'success' : 'danger'}
                    className="px-1 py-0 text-[9px] leading-3"
                    title={
                      enablement.audio
                        ? t('pipeline.nodeList.audioEnabled', 'Audio: enabled')
                        : t(
                            'pipeline.nodeList.audioNotEnabledAgentCapability',
                            'Audio: not enabled (agent capability)',
                          )
                    }
                  >
                    {t('pipeline.nodeList.aud', 'Aud')}
                  </Badge>
                </div>
              </div>
            </Button>
          )
        })}
      </div>

      {/* Footer status */}
      <div className="px-4 py-2 border-t border-border text-[10px] text-foreground-subtle flex items-center justify-between">
        <span>{t('common.onlineCount', { count: onlineCount })}</span>
        {offlineCount > 0 && (
          <span className="text-danger">{t('common.offlineCount', { count: offlineCount })}</span>
        )}
      </div>
    </div>
  )
}
