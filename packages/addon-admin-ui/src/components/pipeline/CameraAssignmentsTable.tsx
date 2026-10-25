/**
 * CameraAssignmentsTable — Cluster → Assignments: WHICH camera runs WHERE.
 *
 * One row per camera of the camera list (never per assignment record: a
 * camera with no session yet and no pin has no record, and was missing from
 * the old table). Columns: the camera, its placement (node pin + accelerator
 * pin — the only editors), the node it last ran on (by NAME), and its live
 * status from the 1 Hz `pipeline.camera-metrics-snapshot` stream. The stream
 * brokers of a camera open in a dialog.
 *
 * Roles here lists Detection / Decode / Audio as coloured pills (live placement
 * from `getCameraStatuses` when available).
 */
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import {
  Badge,
  CHIP_ACTIVE,
  CHIP_BASE,
  CHIP_INACTIVE,
  cn,
  type DataColumn,
  DataTable,
  TABLE_SCROLL_MAX_H,
  useClusterNodes,
  useDeviceManagerListAll,
  usePipelineOrchestratorAssignPipeline,
  usePipelineOrchestratorGetAudioAssignments,
  usePipelineOrchestratorGetCameraStatuses,
  usePipelineOrchestratorGetPipelineAssignments,
  usePipelineOrchestratorListAgentSettings,
  usePipelineOrchestratorUnassignPipeline,
} from '@camstack/ui-library'
import { useEventInvalidation } from '../../hooks/useEventInvalidation'
import {
  type ClusterAssignmentRow,
  buildClusterAssignmentRows,
  enrichClusterRowsWithCameraStatuses,
  nodeNamer,
} from './assignments/assignment-rows'
import { buildColorByNodeId } from './assignments/node-color-map'
import { RolesHereCell } from './assignments/RolesHereCell'
import { AssignmentStatusCell } from './assignments/AssignmentStatusCell'
import {
  BrokerDrillDown,
  PlacementCell,
  ResolvedPlacementCell,
} from './assignments/ClusterRowCells'
import {
  CAMERA_ACTIVITY_CHOICES,
  cameraActivity,
  filterByActivities,
  type CameraActivity,
} from './assignments/camera-activity'
import { useCameraMetricsSnapshots } from './assignments/use-camera-metrics'
import { useTranslation } from 'react-i18next'

export const ASSIGNMENT_EVENTS = [
  'pipeline.camera-assigned',
  'pipeline.camera-unassigned',
  'pipeline.camera-updated',
  'agent.online',
  'agent.offline',
] as const

export function invalidateAssignmentQueries(queryClient: ReturnType<typeof useQueryClient>): void {
  for (const method of ['getPipelineAssignments', 'getAudioAssignments', 'getCameraStatuses']) {
    void queryClient.invalidateQueries({ queryKey: [['pipelineOrchestrator', method]] })
  }
}

export function CameraAssignmentsTable() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  useEventInvalidation(['pipelineOrchestrator', 'getPipelineAssignments'], ASSIGNMENT_EVENTS)
  useEventInvalidation(['pipelineOrchestrator', 'getAudioAssignments'], ASSIGNMENT_EVENTS)
  useEventInvalidation(['pipelineOrchestrator', 'getCameraStatuses'], ASSIGNMENT_EVENTS)

  const { data: cameras } = useDeviceManagerListAll({ isCamera: true, projection: 'slim' })
  const { data: pipelineAssignments } = usePipelineOrchestratorGetPipelineAssignments(undefined)
  const { data: audioAssignments } = usePipelineOrchestratorGetAudioAssignments(undefined)
  const { data: cameraStatuses } = usePipelineOrchestratorGetCameraStatuses({})
  const { data: agentSettings } = usePipelineOrchestratorListAgentSettings(undefined)
  const { nodes } = useClusterNodes()
  const snapshots = useCameraMetricsSnapshots()

  const nameOf = useMemo(() => nodeNamer(nodes), [nodes])
  const colorByNodeId = useMemo(() => buildColorByNodeId(agentSettings), [agentSettings])
  const onlineNodes = useMemo(
    () => nodes.filter((n) => n.isOnline).map((n) => ({ id: n.id, name: n.name })),
    [nodes],
  )
  const rows = useMemo(() => {
    const base = buildClusterAssignmentRows(
      (cameras ?? []).map((c) => ({ id: c.id, name: c.name, disabled: c.disabled })),
      pipelineAssignments ?? [],
      audioAssignments ?? [],
    )
    return enrichClusterRowsWithCameraStatuses(base, cameraStatuses ?? [])
  }, [cameras, pipelineAssignments, audioAssignments, cameraStatuses])

  const [selectedActivities, setSelectedActivities] = useState<ReadonlySet<CameraActivity>>(
    () => new Set(),
  )

  const filteredRows = useMemo(
    () =>
      rows.filter((row) =>
        filterByActivities(
          cameraActivity({
            hasPipelineAssignment: row.pipeline.active,
            hasFreshMetrics: snapshots.has(row.deviceId),
          }),
          selectedActivities,
        ),
      ),
    [rows, snapshots, selectedActivities],
  )

  const toggleActivityFilter = (activity: CameraActivity): void => {
    setSelectedActivities((prev) => {
      const next = new Set(prev)
      if (next.has(activity)) next.delete(activity)
      else next.add(activity)
      return next
    })
  }

  const invalidate = (): void => invalidateAssignmentQueries(queryClient)
  const assign = usePipelineOrchestratorAssignPipeline({ onSuccess: invalidate })
  const unassign = usePipelineOrchestratorUnassignPipeline({ onSuccess: invalidate })
  const pending = assign.isPending || unassign.isPending

  const columns: readonly DataColumn<ClusterAssignmentRow>[] = [
    {
      key: 'camera',
      header: t('pipeline.cameraAssignmentsTable.camera', 'Camera'),
      width: 'w-44',
      sortValue: (row) => row.deviceName,
      render: (row) => (
        <div className="flex w-44 min-w-0 items-center gap-1.5">
          <Link
            to={`/devices/${String(row.deviceId)}`}
            className="min-w-0 truncate text-xs font-medium text-primary hover:underline"
            title={row.deviceName}
          >
            {row.deviceName}
          </Link>
          {row.disabled && <Badge variant="default">{t('common.off')}</Badge>}
        </div>
      ),
    },
    {
      key: 'placement',
      header: t('pipeline.cameraAssignmentsTable.placement', 'Placement'),
      width: 'w-80',
      notSortableReason: 'A pair of controls — editing one would move the row under the cursor.',
      render: (row) => (
        <PlacementCell
          deviceId={row.deviceId}
          state={row.pipeline}
          onlineNodes={onlineNodes}
          nameOf={nameOf}
          pending={pending}
          onChange={(target) =>
            target === 'auto'
              ? unassign.mutate({ deviceId: row.deviceId })
              : assign.mutate({ deviceId: row.deviceId, agentNodeId: target })
          }
        />
      ),
    },
    {
      key: 'roles',
      header: t('pipeline.cameraAssignmentsTable.rolesHere', 'Roles here'),
      notSortableReason: 'A set of roles has no single order.',
      render: (row) => (
        <RolesHereCell
          detection={row.detection}
          decoder={row.decoder}
          audio={row.audio}
          nameOf={nameOf}
          colorByNodeId={colorByNodeId}
        />
      ),
    },
    {
      key: 'resolved',
      header: t('pipeline.cameraAssignmentsTable.runningOn', 'Running on'),
      width: 'w-40',
      sortValue: (row) => (row.pipeline.nodeId !== null ? nameOf(row.pipeline.nodeId) : null),
      render: (row) => <ResolvedPlacementCell state={row.pipeline} nameOf={nameOf} />,
    },
    {
      key: 'status',
      header: t('pipeline.cameraAssignmentsTable.status', 'Status'),
      width: 'w-40',
      sortValue: (row) => snapshots.get(row.deviceId)?.metrics.actualFps ?? null,
      render: (row) => <AssignmentStatusCell snap={snapshots.get(row.deviceId)} />,
    },
    {
      key: 'brokers',
      header: '',
      align: 'right',
      width: 'w-10',
      notSortableReason: 'An action',
      render: (row) => <BrokerDrillDown deviceId={row.deviceId} deviceName={row.deviceName} />,
    },
  ]

  const emptyMessage =
    cameras === undefined
      ? 'Loading cameras…'
      : rows.length === 0
        ? 'No cameras'
        : 'No cameras match this activity filter.'

  return (
    <div className="flex flex-col gap-2">
      <nav
        aria-label={t(
          'pipeline.cameraAssignmentsTable.filterByCameraActivity',
          'Filter by camera activity',
        )}
        data-testid="assignments-activity-filter"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {CAMERA_ACTIVITY_CHOICES.map((choice) => {
            const pressed = selectedActivities.has(choice.value)
            return (
              <button // ui-check-ok: CHIP_* facet pill (CorpusFilterBar pattern)
                key={choice.value}
                type="button"
                aria-pressed={pressed}
                data-testid={`assignments-activity-${choice.value}`}
                className={cn(CHIP_BASE, pressed ? CHIP_ACTIVE : CHIP_INACTIVE)}
                onClick={() => toggleActivityFilter(choice.value)}
              >
                {choice.label}
              </button>
            )
          })}
        </div>
      </nav>
      <DataTable
        columns={columns}
        rows={filteredRows}
        rowKey={(row) => row.deviceId}
        minWidthPx={920}
        maxBodyHeight={TABLE_SCROLL_MAX_H}
        emptyMessage={emptyMessage}
      />
    </div>
  )
}
