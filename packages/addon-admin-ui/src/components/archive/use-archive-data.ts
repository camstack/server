/**
 * The Archive's reads, made once. Every section of the overview and of the
 * camera page takes its camera roster, footage, event footprint, statuses and
 * findings from here, so a page mounts ONE fetch of each instead of one per
 * section.
 *
 * A source that has not answered is `null` (see camera-rows.ts), never `[]`.
 */
import type {
  CameraStatus,
  EventStoreFootprint,
  HealthFinding,
  RecordingStorageUsage,
} from '@dominevo/types'
import {
  useDeviceManagerListAll,
  usePipelineAnalyticsGetEventStoreFootprint,
  usePipelineOrchestratorGetCameraStatuses,
  usePipelineOrchestratorGetHealthDigest,
  useRecordingArchiveGetStorageUsage,
} from '@dominevo/ui-library'
import { useMemo } from 'react'
import {
  type CameraRef,
  type CameraRow,
  mergeCameraRows,
  summarizeCameraRows,
  type ArchiveTotals,
} from './camera-rows'

export interface ArchiveData {
  readonly cameras: readonly CameraRef[]
  readonly rows: readonly CameraRow[]
  readonly totals: ArchiveTotals
  readonly usage: RecordingStorageUsage | null
  readonly footprint: EventStoreFootprint | null
  readonly statuses: readonly CameraStatus[] | null
  readonly findings: readonly HealthFinding[] | null
  /** When the health digest was built; `null` until its first tick. */
  readonly digestAtMs: number | null
  readonly isLoading: boolean
}

export function useArchiveData(): ArchiveData {
  // Cameras only, slim, and the query client's fleet window (D274): one fetch for the whole page.
  const devices = useDeviceManagerListAll({ isCamera: true, projection: 'slim' })
  const usageQuery = useRecordingArchiveGetStorageUsage({}, { refetchOnWindowFocus: false })
  const footprintQuery = usePipelineAnalyticsGetEventStoreFootprint(
    {},
    { refetchOnWindowFocus: false },
  )
  const statusQuery = usePipelineOrchestratorGetCameraStatuses({}, { refetchOnWindowFocus: false })
  const digestQuery = usePipelineOrchestratorGetHealthDigest(
    { history: 1 },
    { refetchOnWindowFocus: false },
  )

  const cameras = useMemo<readonly CameraRef[]>(
    () =>
      (devices.data ?? [])
        .map((d) => ({ id: d.id, name: d.name }))
        .toSorted((a, b) => a.name.localeCompare(b.name)),
    [devices.data],
  )
  // `unavailable` means the recorder REFUSED the table: not "no camera has footage".
  const usage = usageQuery.data ?? null
  const footageRead = usage !== null && usage.devicesRead !== 'unavailable'
  const footprint = footprintQuery.data ?? null
  const statuses = statusQuery.data ?? null
  const latest = digestQuery.data?.latest ?? null
  const findings = latest === null ? null : latest.findings

  const rows = useMemo(
    () =>
      mergeCameraRows({
        cameras,
        footage: footageRead ? usage.devices : null,
        events: footprint === null ? null : footprint.devices,
        statuses,
        findings,
      }),
    [cameras, footageRead, usage, footprint, statuses, findings],
  )
  const totals = useMemo(() => summarizeCameraRows(rows), [rows])

  return {
    cameras,
    rows,
    totals,
    usage,
    footprint,
    statuses,
    findings,
    digestAtMs: latest === null ? null : latest.generatedAt,
    isLoading: devices.isLoading || usageQuery.isLoading || footprintQuery.isLoading,
  }
}
