/**
 * Per-function health rows for one camera: CameraStatus (what is running) plus
 * the health digest's findings for this deviceId (what looks wrong).
 *
 * Off is not broken (D62) and an unread stage is unknown, never fine (D315).
 */
import type {
  CameraStatus,
  CameraSwitchId,
  HealthFinding,
  HealthFindingKind,
} from '@camstack/types'

/** The slice of a CameraStatus the health rows read. */
export type HealthStatusFacts = Pick<
  CameraStatus,
  'recording' | 'motion' | 'detection' | 'switchedOff' | 'degraded'
>

export type CameraFunctionId = 'recording' | 'motion' | 'detection' | 'event-media'
export type FunctionState = 'ok' | 'off' | 'warning' | 'critical' | 'unknown'

export interface FunctionHealth {
  readonly fn: CameraFunctionId
  readonly state: FunctionState
  readonly findings: readonly HealthFinding[]
}

const FUNCTION_SWITCH: Readonly<Record<CameraFunctionId, CameraSwitchId | null>> = {
  recording: 'recording',
  motion: null,
  detection: 'object-detection',
  'event-media': 'event-saving',
}

const FINDING_FUNCTION: Readonly<Record<HealthFindingKind, CameraFunctionId | null>> = {
  'motion-without-detections': 'motion',
  'detections-under-floor': 'detection',
  'inference-too-slow': 'detection',
  'frames-shed': 'detection',
  'inference-device-unusable': null,
}

const FUNCTION_STAGE: Readonly<Record<CameraFunctionId, 'recording' | 'detection' | null>> = {
  recording: 'recording',
  motion: null,
  detection: 'detection',
  'event-media': null,
}

export const CAMERA_FUNCTIONS: readonly CameraFunctionId[] = [
  'recording',
  'motion',
  'detection',
  'event-media',
]

/** The state the status block alone supports; `null` = no block, so unknown. */
function blockState(fn: CameraFunctionId, status: HealthStatusFacts): FunctionState | null {
  switch (fn) {
    case 'recording':
      if (status.recording === null) return null
      return status.recording.active ? 'ok' : 'warning'
    case 'motion':
      if (status.motion === null) return null
      return status.motion.enabled ? 'ok' : 'off'
    case 'detection':
      // `idle` is a camera waiting for motion, not a fault.
      return status.detection === null ? null : 'ok'
    case 'event-media':
      return 'ok'
  }
}

function worst(findings: readonly HealthFinding[]): FunctionState {
  if (findings.some((f) => f.severity === 'critical')) return 'critical'
  if (findings.some((f) => f.severity === 'warning')) return 'warning'
  return 'ok'
}

export function buildCameraHealth(
  status: HealthStatusFacts | undefined,
  findings: readonly HealthFinding[],
): readonly FunctionHealth[] {
  return CAMERA_FUNCTIONS.map((fn): FunctionHealth => {
    const own = findings.filter((f) => FINDING_FUNCTION[f.kind] === fn)
    if (status === undefined)
      return { fn, state: own.length > 0 ? worst(own) : 'unknown', findings: own }
    const sw = FUNCTION_SWITCH[fn]
    if (sw !== null && status.switchedOff.includes(sw)) return { fn, state: 'off', findings: own }
    const stage = FUNCTION_STAGE[fn]
    if (stage !== null && status.degraded.some((d) => d.stage === stage)) {
      return { fn, state: own.length > 0 ? worst(own) : 'unknown', findings: own }
    }
    if (own.length > 0) return { fn, state: worst(own), findings: own }
    if (fn === 'recording' && status.recording?.mode === 'off')
      return { fn, state: 'off', findings: own }
    return { fn, state: blockState(fn, status) ?? 'unknown', findings: own }
  })
}
