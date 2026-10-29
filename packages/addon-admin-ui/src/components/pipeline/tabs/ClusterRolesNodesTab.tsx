/**
 * Cluster → Roles & nodes — WHO does what in the cluster: the singleton cluster
 * roles (ingest / recording / audio / motion / post-processing) and each
 * node's placement capabilities.
 * Where event media is stored (the `eventMedia` storage location) is not a
 * role: it is managed on Recordings → Events, beside the event store it holds.
 * How much detection each node and accelerator carries lives on the Load
 * balancing tab (D748); nothing here is a share or a cap.
 *
 * Two section cards at Load-balancing density: the roles (one row each, the
 * library `Select`, nodes by name) and the node table (`NodeCapabilitiesTable`,
 * the shared `DataTable`, which scrolls sideways on a phone).
 */
import { useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Crown, Loader2, Server } from 'lucide-react'
import {
  SectionCard,
  TEXT_HINT,
  useAddonSettingsGetGlobalSettings,
  useAddonSettingsUpdateGlobalSettings,
  useClusterNodes,
  usePipelineOrchestratorListAgentSettings,
  usePipelineOrchestratorSetAgentCapabilities,
} from '@camstack/ui-library'
import { effectiveCapabilitySettings } from '../lib/node-enablement'
import {
  ANALYTICS_ADDON_ID,
  ORCHESTRATOR_ADDON_ID,
  POST_PROCESSING_NODE_KEY,
  RECORDER_ADDON_ID,
  RECORDING_NODE_KEY,
  ROLE_FIELDS,
  invalidatePlacementQueries,
  readStringField,
  type BoardNode,
  type CapabilityKey,
  type PlacementActions,
  type RoleField,
} from '../placement-board/board-model'
import { NodeCapabilitiesTable } from '../placement-board/NodeCapabilitiesTable'
import { RoleControls, type RoleNodeOption } from '../placement-board/RoleControls'
import { useTranslation } from 'react-i18next'

export function ClusterRolesNodesTab() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { nodes } = useClusterNodes()
  const settingsQuery = usePipelineOrchestratorListAgentSettings(undefined)
  const globalSettingsQuery = useAddonSettingsGetGlobalSettings({ addonId: ORCHESTRATOR_ADDON_ID })
  // Recorder addon's canonical recording-node setting — the "Recording" picker's
  // read/write target (single source of truth), separate from orchestrator roles.
  const recorderSettingsQuery = useAddonSettingsGetGlobalSettings({ addonId: RECORDER_ADDON_ID })
  const analyticsSettingsQuery = useAddonSettingsGetGlobalSettings({ addonId: ANALYTICS_ADDON_ID })

  const invalidate = (): void => invalidatePlacementQueries(queryClient)
  const setCapabilities = usePipelineOrchestratorSetAgentCapabilities({ onSuccess: invalidate })
  const updateGlobal = useAddonSettingsUpdateGlobalSettings({ onSuccess: invalidate })

  const settingsByNode = useMemo(() => {
    const map = new Map<string, object>()
    for (const row of settingsQuery.data ?? []) {
      map.set(row.nodeId, row.settings)
    }
    return map
  }, [settingsQuery.data])

  const boardNodes = useMemo<readonly BoardNode[]>(() => {
    return nodes.map((node) => {
      const settings = settingsByNode.get(node.id)
      const effective = effectiveCapabilitySettings(settings)
      return {
        id: node.id,
        name: node.name,
        isHub: node.isHub,
        isOnline: node.isOnline,
        settings,
        effective,
      }
    })
  }, [nodes, settingsByNode])

  const roleValues: Readonly<Record<RoleField, string>> = {
    ingestNode: readStringField(globalSettingsQuery.data, 'ingestNode', 'hub'),
    // Canonical recorder setting — NOT an orchestrator field.
    recordingNode: readStringField(recorderSettingsQuery.data, RECORDING_NODE_KEY, 'hub'),
    audioNode: readStringField(globalSettingsQuery.data, 'audioNode', 'hub'),
    motionNode: readStringField(globalSettingsQuery.data, 'motionNode', 'hub'),
    postProcessingNode: readStringField(
      analyticsSettingsQuery.data,
      POST_PROCESSING_NODE_KEY,
      'hub',
    ),
  }

  const nodeOptions = useMemo<readonly RoleNodeOption[]>(() => {
    const ids = nodes.filter((node) => node.isOnline).map((node) => node.id)
    const nameOf = (id: string): string => nodes.find((n) => n.id === id)?.name || id
    return [...new Set(['hub', ...ROLE_FIELDS.map((role) => roleValues[role]), ...ids])]
      .filter((id) => id.length > 0)
      .map((id) => ({ id, name: nameOf(id) }))
  }, [nodes, roleValues])

  const isLoading =
    settingsQuery.isLoading ||
    globalSettingsQuery.isLoading ||
    recorderSettingsQuery.isLoading ||
    analyticsSettingsQuery.isLoading

  const handleToggleCapability = (
    agentNodeId: string,
    capability: CapabilityKey,
    enabled: boolean,
  ): void => {
    setCapabilities.mutate({ agentNodeId, [capability]: enabled })
  }

  const handleRoleChange = (role: RoleField, nodeId: string): void => {
    // The "Recording" picker drives the recorder addon's canonical
    // `recordingNodeId`; ingest/audio remain orchestrator cluster roles.
    if (role === 'recordingNode') {
      updateGlobal.mutate({ addonId: RECORDER_ADDON_ID, patch: { [RECORDING_NODE_KEY]: nodeId } })
      return
    }
    if (role === 'postProcessingNode') {
      updateGlobal.mutate({
        addonId: ANALYTICS_ADDON_ID,
        patch: { [POST_PROCESSING_NODE_KEY]: nodeId },
      })
      return
    }
    updateGlobal.mutate({ addonId: ORCHESTRATOR_ADDON_ID, patch: { [role]: nodeId } })
  }

  const actions: PlacementActions = {
    capabilityPending: setCapabilities.isPending,
    onToggleCapability: handleToggleCapability,
  }

  const loading = isLoading ? (
    <Loader2
      className="h-3.5 w-3.5 animate-spin text-foreground-subtle"
      aria-label={t('pipeline.clusterRolesNodesTab.loading', 'Loading')}
    />
  ) : null

  return (
    <div className="space-y-3 sm:space-y-4">
      <SectionCard
        headingId="roles-nodes-cluster-roles"
        title={t('pipeline.clusterRolesNodesTab.clusterRoles', 'Cluster roles')}
        icon={Crown}
        actions={loading}
      >
        <p className={`${TEXT_HINT} border-b border-border px-3 py-1.5 sm:px-4`}>
          {t(
            'pipeline.clusterRolesNodesTab.oneNodeHoldsEachRole',
            'One node holds each role for every camera. Detection shares and caps are on Load balancing.',
          )}
        </p>
        <RoleControls
          roleValues={roleValues}
          options={nodeOptions}
          pending={updateGlobal.isPending}
          onRoleChange={handleRoleChange}
        />
      </SectionCard>

      <SectionCard
        headingId="roles-nodes-node-capabilities"
        title={t('pipeline.clusterRolesNodesTab.nodeCapabilities', 'Node capabilities')}
        icon={Server}
      >
        <NodeCapabilitiesTable nodes={boardNodes} actions={actions} />
      </SectionCard>
    </div>
  )
}
