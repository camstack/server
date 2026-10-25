/**
 * use-cameras-overview — data layer for the Pipeline → Cameras roster.
 *
 * One batched, polled query drives the whole page:
 *   - `pipelineOrchestrator.getCameraStatuses` (server-composed aggregate,
 *     one call for every camera) refetched every POLL_INTERVAL_MS.
 *   - `deviceManager.listAll` for camera names.
 *   - `pipeline.camera-metrics-snapshot` live events (1 Hz from the runner)
 *     overlay fresher detection runtime numbers between polls; stale
 *     snapshots are evicted so a dead runner doesn't freeze fake numbers.
 */
import { useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  useClusterNodes,
  useLiveEvent,
  usePipelineOrchestratorGetCameraStatuses,
} from '@camstack/ui-library'
import { EventCategory } from '@camstack/types'
import type { CameraStatus } from '@camstack/types'
import type { SystemLiveEvent } from '@camstack/sdk'
import { useDeviceList } from '../../../hooks/useDevice'

const POLL_INTERVAL_MS = 5_000
const SNAPSHOT_STALE_MS = 10_000
const SNAPSHOT_SWEEP_MS = 5_000

// ---------------------------------------------------------------------------
// Live detection metrics (1 Hz snapshot events)
// ---------------------------------------------------------------------------

export interface LiveDetectionMetrics {
  readonly phase: string
  readonly configuredFps: number
  readonly actualFps: number
  readonly queueDepth: number
  readonly avgInferenceTimeMs: number
  readonly droppedFrames: number
  readonly timestamp: number
}

interface CameraMetricsSnapshotPayload {
  readonly deviceId: number
  readonly nodeId: string
  readonly metrics: {
    readonly detectionMode: string
    readonly configuredFps: number
    readonly actualFps: number
    readonly queueDepth: number
    readonly avgInferenceTimeMs: number
    readonly droppedFrames: number
    readonly phase: string
  }
  readonly timestamp: number
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface CameraOverviewRow {
  readonly deviceId: number
  readonly name: string
  readonly online: boolean
  readonly status: CameraStatus | undefined
}

export interface ClusterNodeOption {
  readonly id: string
  readonly name: string
}

export interface CamerasOverviewData {
  readonly rows: readonly CameraOverviewRow[]
  readonly liveMetrics: ReadonlyMap<number, LiveDetectionMetrics>
  readonly onlineNodes: readonly ClusterNodeOption[]
  readonly isLoading: boolean
}

/**
 * @param refreshToken bumping this forces an immediate refetch of the
 *   batched status query (wired to the page-level Refresh button).
 */
export function useCamerasOverview(refreshToken: number): CamerasOverviewData {
  const queryClient = useQueryClient()
  const { data: devices, isLoading: devicesLoading } = useDeviceList()
  const { data: statuses, isLoading: statusesLoading } = usePipelineOrchestratorGetCameraStatuses(
    {},
    { refetchInterval: POLL_INTERVAL_MS },
  )
  const { nodes: clusterNodes } = useClusterNodes()

  // Page-level Refresh button → force a refetch of the batched aggregate.
  useEffect(() => {
    if (refreshToken === 0) return
    void queryClient.invalidateQueries({
      queryKey: [['pipelineOrchestrator', 'getCameraStatuses']],
    })
  }, [refreshToken, queryClient])

  // 1 Hz live overlay for detection runtime numbers.
  const [liveMetrics, setLiveMetrics] = useState<ReadonlyMap<number, LiveDetectionMetrics>>(
    new Map(),
  )

  useLiveEvent<CameraMetricsSnapshotPayload>(
    EventCategory.PipelineCameraMetricsSnapshot,
    (event: SystemLiveEvent<CameraMetricsSnapshotPayload>) => {
      const payload = event.data
      if (typeof payload.deviceId !== 'number') return
      setLiveMetrics((prev) => {
        const next = new Map(prev)
        next.set(payload.deviceId, {
          phase: payload.metrics.phase,
          configuredFps: payload.metrics.configuredFps,
          actualFps: payload.metrics.actualFps,
          queueDepth: payload.metrics.queueDepth,
          avgInferenceTimeMs: payload.metrics.avgInferenceTimeMs,
          droppedFrames: payload.metrics.droppedFrames,
          timestamp: payload.timestamp,
        })
        return next
      })
    },
  )

  // Evict stale snapshots so a silent runner falls back to polled data.
  useEffect(() => {
    if (liveMetrics.size === 0) return
    const interval = setInterval(() => {
      setLiveMetrics((prev) => {
        const cutoff = Date.now() - SNAPSHOT_STALE_MS
        let changed = false
        const next = new Map(prev)
        for (const [deviceId, snapshot] of prev) {
          if (snapshot.timestamp < cutoff) {
            next.delete(deviceId)
            changed = true
          }
        }
        return changed ? next : prev
      })
    }, SNAPSHOT_SWEEP_MS)
    return () => clearInterval(interval)
  }, [liveMetrics.size])

  const statusByDeviceId = useMemo<ReadonlyMap<number, CameraStatus>>(() => {
    const map = new Map<number, CameraStatus>()
    for (const status of statuses ?? []) map.set(status.deviceId, status)
    return map
  }, [statuses])

  const rows = useMemo<readonly CameraOverviewRow[]>(() => {
    const cameras = (devices ?? []).filter((device) => device.isCamera)
    return cameras
      .map((device) => ({
        deviceId: device.id,
        name: device.name,
        online: device.online,
        status: statusByDeviceId.get(device.id),
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [devices, statusByDeviceId])

  const onlineNodes = useMemo<readonly ClusterNodeOption[]>(
    () =>
      (clusterNodes ?? [])
        .filter((node) => node.isOnline)
        .map((node) => ({ id: node.id, name: node.name })),
    [clusterNodes],
  )

  return {
    rows,
    liveMetrics,
    onlineNodes,
    isLoading: devicesLoading || statusesLoading,
  }
}
