/**
 * The Archive overview's ONE camera table, merged from four independent reads.
 *
 * Each source is `null` when its query has not ANSWERED (failed or still
 * loading) and an array when it did. The difference matters (D315, D393): a
 * camera missing from an answered footage list holds no footage (0), while the
 * same camera under an unanswered list is unknown (`null`), never 0.
 *
 * Switched-off is reported off, never broken (D62).
 */
import type {
  CameraStatus,
  CameraSwitchId,
  EventStoreDeviceFootprint,
  HealthFinding,
  RecordingDeviceUsage,
  RecordingStorageMode,
} from '@camstack/types'

/** The slice of a CameraStatus the table reads. */
export type RowStatusFacts = Pick<
  CameraStatus,
  'deviceId' | 'recording' | 'switchedOff' | 'degraded'
>

export type CameraRowState = 'recording' | 'off' | 'degraded' | 'unknown'

export interface CameraRef {
  readonly id: number
  readonly name: string
}

export interface CameraRow {
  readonly deviceId: number
  readonly name: string
  /** `null` = the camera has no recording block (or its status is unknown). */
  readonly mode: RecordingStorageMode | null
  readonly state: CameraRowState
  /** Open warning/critical findings about this camera. */
  readonly warnings: number
  /** `null` = footage usage was not read. */
  readonly footageBytes: number | null
  /** `null` = unknown or no footage. */
  readonly oldestMs: number | null
  /** `null` = the event store was not read. */
  readonly eventRows: number | null
  readonly eventBytes: number | null
}

export interface MergeCameraRowsInput {
  readonly cameras: readonly CameraRef[]
  readonly footage: readonly RecordingDeviceUsage[] | null
  readonly events: readonly EventStoreDeviceFootprint[] | null
  readonly statuses: readonly RowStatusFacts[] | null
  readonly findings: readonly HealthFinding[] | null
}

const RECORDING_OFF: CameraSwitchId = 'recording'

/** Findings of a camera that need attention (info does not count). */
export function cameraFindings(
  findings: readonly HealthFinding[] | null,
  deviceId: number,
): readonly HealthFinding[] {
  return (findings ?? []).filter(
    (f) => f.subject.type === 'camera' && f.subject.deviceId === deviceId,
  )
}

function actionable(findings: readonly HealthFinding[]): number {
  return findings.filter((f) => f.severity !== 'info').length
}

export function deriveCameraState(
  status: RowStatusFacts | undefined,
  warnings: number,
): CameraRowState {
  if (status === undefined) return 'unknown'
  const switchedOff = status.switchedOff.includes(RECORDING_OFF)
  if (switchedOff || status.recording?.mode === 'off') return 'off'
  // A stage we could not read supports no conclusion at all.
  if (status.degraded.some((d) => d.stage === 'recording' || d.stage === 'switches')) {
    return 'unknown'
  }
  if (status.recording === null) return 'unknown'
  if (warnings > 0 || !status.recording.active) return 'degraded'
  return 'recording'
}

export function mergeCameraRows(input: MergeCameraRowsInput): readonly CameraRow[] {
  const footageById = new Map((input.footage ?? []).map((f) => [f.deviceId, f]))
  const eventsById = new Map((input.events ?? []).map((e) => [e.deviceId, e]))
  const statusById = new Map((input.statuses ?? []).map((s) => [s.deviceId, s]))
  return input.cameras.map((cam): CameraRow => {
    const warnings = actionable(cameraFindings(input.findings, cam.id))
    const status = statusById.get(cam.id)
    const footage = footageById.get(cam.id)
    const events = eventsById.get(cam.id)
    return {
      deviceId: cam.id,
      name: cam.name,
      mode: status?.recording?.mode ?? null,
      state: deriveCameraState(status, warnings),
      warnings,
      footageBytes: input.footage === null ? null : (footage?.usedBytes ?? 0),
      oldestMs: footage?.oldestMs ?? null,
      eventRows: input.events === null ? null : (events?.rows ?? 0),
      eventBytes: input.events === null ? null : (events?.bytes ?? 0),
    }
  })
}

export interface ArchiveTotals {
  readonly recording: number
  readonly degraded: number
  readonly off: number
  readonly unknown: number
  readonly warnings: number
}

export function summarizeCameraRows(rows: readonly CameraRow[]): ArchiveTotals {
  const count = (state: CameraRowState): number => rows.filter((r) => r.state === state).length
  return {
    recording: count('recording'),
    degraded: count('degraded'),
    off: count('off'),
    unknown: count('unknown'),
    warnings: rows.reduce((sum, r) => sum + r.warnings, 0),
  }
}
