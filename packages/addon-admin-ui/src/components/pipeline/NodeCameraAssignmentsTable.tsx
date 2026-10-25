/**
 * NodeCameraAssignmentsTable — node → Assignments: the cameras that run on
 * THIS node right now.
 *
 * Row inclusion comes from `getCameraStatuses` (the orchestrator's live
 * placement, session-time dispatch included), not from the persisted records:
 * a record pointing here for a camera that is not dispatched here (an
 * on-motion camera between sessions, a stale pin) must not produce a row.
 *
 * The roles a camera holds here are LABELS (Detection, Decode, Audio); a role
 * held elsewhere is named with its node. They are read-only facts — the old
 * table drew them as ticked squares, which read as checkboxes that did
 * nothing. Moving or unpinning a role is in the row's menu.
 */
import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import {
  type DataColumn,
  DataTable,
  KebabMenu,
  type KebabMenuItem,
  TABLE_SCROLL_MAX_H,
  useClusterNodes,
  useDeviceManagerListAll,
  usePipelineOrchestratorAssignAudio,
  usePipelineOrchestratorAssignPipeline,
  usePipelineOrchestratorGetCameraStatuses,
  usePipelineOrchestratorListAgentSettings,
  usePipelineOrchestratorUnassignAudio,
  usePipelineOrchestratorUnassignPipeline,
} from '@camstack/ui-library'
import { useEventInvalidation } from '../../hooks/useEventInvalidation'
import {
  type NodeAssignmentRow,
  buildNodeAssignmentRows,
  cameraNamer,
  nodeNamer,
} from './assignments/assignment-rows'
import { buildColorByNodeId } from './assignments/node-color-map'
import { RolesHereCell } from './assignments/RolesHereCell'
import { AssignmentStatusCell } from './assignments/AssignmentStatusCell'
import { useCameraMetricsSnapshots } from './assignments/use-camera-metrics'
import { ASSIGNMENT_EVENTS, invalidateAssignmentQueries } from './CameraAssignmentsTable'
import { useTranslation } from 'react-i18next'

export function NodeCameraAssignmentsTable({ nodeId }: { readonly nodeId: string }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  useEventInvalidation(['pipelineOrchestrator', 'getCameraStatuses'], ASSIGNMENT_EVENTS)
  const { data: statuses } = usePipelineOrchestratorGetCameraStatuses({})
  const { data: agentSettings } = usePipelineOrchestratorListAgentSettings(undefined)
  const { data: cameras } = useDeviceManagerListAll({ isCamera: true, projection: 'slim' })
  const { nodes } = useClusterNodes()
  const snapshots = useCameraMetricsSnapshots()

  const nameOf = useMemo(() => nodeNamer(nodes), [nodes])
  const colorByNodeId = useMemo(() => buildColorByNodeId(agentSettings), [agentSettings])
  const rows = useMemo(
    () =>
      buildNodeAssignmentRows(
        nodeId,
        statuses ?? [],
        cameraNamer((cameras ?? []).map((c) => ({ id: c.id, name: c.name }))),
      ),
    [nodeId, statuses, cameras],
  )
  const otherNodes = nodes.filter((n) => n.isOnline && n.id !== nodeId)

  const invalidate = (): void => invalidateAssignmentQueries(queryClient)
  const assignPipeline = usePipelineOrchestratorAssignPipeline({ onSuccess: invalidate })
  const unassignPipeline = usePipelineOrchestratorUnassignPipeline({ onSuccess: invalidate })
  const assignAudio = usePipelineOrchestratorAssignAudio({ onSuccess: invalidate })
  const unassignAudio = usePipelineOrchestratorUnassignAudio({ onSuccess: invalidate })

  const menuFor = (row: NodeAssignmentRow): readonly KebabMenuItem[] => [
    ...(row.detection.active
      ? otherNodes.map((n) => ({
          id: `detect-${n.id}`,
          label: t(
            'pipeline.nodeCameraAssignmentsTable.moveDetectionTo',
            'Move detection to {{name}}',
            { name: n.name },
          ),
          onClick: () => assignPipeline.mutate({ deviceId: row.deviceId, agentNodeId: n.id }),
        }))
      : []),
    ...(row.audio.active
      ? otherNodes.map((n) => ({
          id: `audio-${n.id}`,
          label: t('pipeline.nodeCameraAssignmentsTable.moveAudioTo', 'Move audio to {{name}}', {
            name: n.name,
          }),
          onClick: () => assignAudio.mutate({ deviceId: row.deviceId, nodeId: n.id }),
        }))
      : []),
    {
      id: 'unpin-detect',
      label: t('pipeline.nodeCameraAssignmentsTable.unpinDetection', 'Unpin detection'),
      hidden: !(row.detection.active && row.detection.pinned),
      separatorBefore: true,
      onClick: () => unassignPipeline.mutate({ deviceId: row.deviceId }),
    },
    {
      id: 'unpin-audio',
      label: t('pipeline.nodeCameraAssignmentsTable.unpinAudio', 'Unpin audio'),
      hidden: !(row.audio.active && row.audio.pinned),
      onClick: () => unassignAudio.mutate({ deviceId: row.deviceId }),
    },
  ]

  const columns: readonly DataColumn<NodeAssignmentRow>[] = [
    {
      key: 'camera',
      header: t('pipeline.nodeCameraAssignmentsTable.camera', 'Camera'),
      width: 'w-44',
      sortValue: (row) => row.deviceName,
      render: (row) => (
        <Link
          to={`/devices/${String(row.deviceId)}`}
          className="block w-44 truncate text-xs font-medium text-primary hover:underline"
          title={row.deviceName}
        >
          {row.deviceName}
        </Link>
      ),
    },
    {
      key: 'roles',
      header: t('pipeline.nodeCameraAssignmentsTable.rolesHere', 'Roles here'),
      notSortableReason: 'A set of roles has no single order.',
      render: (row) => (
        <RolesHereCell
          detection={row.detection}
          decoder={row.decoder}
          audio={row.audio}
          nameOf={nameOf}
          colorByNodeId={colorByNodeId}
          emphasizeOnNodeId={nodeId}
        />
      ),
    },
    {
      key: 'status',
      header: t('pipeline.nodeCameraAssignmentsTable.status', 'Status'),
      width: 'w-40',
      sortValue: (row) => snapshots.get(row.deviceId)?.metrics.actualFps ?? null,
      render: (row) => <AssignmentStatusCell snap={snapshots.get(row.deviceId)} />,
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      width: 'w-10',
      notSortableReason: 'Actions',
      render: (row) => (
        <KebabMenu
          items={menuFor(row)}
          title={t('pipeline.nodeCameraAssignmentsTable.move', 'Move {{deviceName}}', {
            deviceName: row.deviceName,
          })}
        />
      ),
    },
  ]

  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(row) => row.deviceId}
      minWidthPx={560}
      maxBodyHeight={TABLE_SCROLL_MAX_H}
      emptyMessage={
        statuses === undefined
          ? t('pipeline.nodeCameraAssignmentsTable.loadingCameras', 'Loading cameras…')
          : t(
              'pipeline.nodeCameraAssignmentsTable.noCameraRunsOnThis',
              'No camera runs on this node right now',
            )
      }
    />
  )
}
