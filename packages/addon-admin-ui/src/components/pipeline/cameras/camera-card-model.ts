/**
 * camera-card-model — pure derivations for the Pipeline → Cameras roster.
 *
 * Three responsibilities, all side-effect free (no React, unit-testable):
 *
 *  1. `deriveCameraProblems` — turns a `CameraStatus` snapshot into a list of
 *     loud, human-readable operational problems. The flagship rule is the
 *     cross-node black-hole signature: detection phase `active` with
 *     `actualFps === 0` means the pipeline THINKS it's running but no frames
 *     reach the detector — that camera must never look healthy. It is the
 *     only stall rule: `actualFps` is the frames actually delivered to and
 *     processed by the detector, a counter something feeds. (A second rule
 *     read the decoder's shared-memory `framesWritten`, which nothing has fed
 *     since that plane was retired — it flagged every active camera.)
 *
 *  2. `extractOrchestratorCameraSettings` — pulls the per-camera pipeline
 *     parameters (detection mode, FPS knobs, motion sources, stream profiles,
 *     node pins) out of the orchestrator's hydrated device-settings schema
 *     (`addonSettings.getDeviceSettings`, addonId `pipeline-orchestrator`).
 *     The walk is STRUCTURAL over `unknown` — the tRPC wire shape for
 *     hydrated schemas is loosely typed, and a guard-based walk avoids any
 *     boundary cast. Also reports which keys carry a value that differs from
 *     the schema default — i.e. an override is active for this camera.
 *
 *  3. `flattenPipelineSteps` — flattens the resolved per-camera step tree
 *     (`pipelineOrchestrator.resolvePipeline`) into displayable rows.
 */
import { CAMERA_SENSORS_NOT_LOADED, collectHydratedFieldEntries } from '@camstack/types'
import type {
  CameraSensorAttachment,
  CameraSensorsNotForwarded,
  CameraSensorsStatus,
  CameraStatus,
  PipelineStepInputOutput,
} from '@camstack/types'
import { isArmedCamera } from './camera-health'
import i18n from '../../../i18n/index'

// ---------------------------------------------------------------------------
// Problems
// ---------------------------------------------------------------------------

export type CameraProblemSeverity = 'error' | 'warning'

export type CameraProblemCode =
  | 'provisioning-failed'
  | 'unassigned'
  | 'detection-black-hole'
  | 'broker-stalled'
  | 'status-unreadable'
  | 'camera-sensors-unreadable'
  | 'camera-sensors-not-forwarded'
  | 'camera-sensors-not-enforced'
  | 'camera-sensor-missing'
  | 'camera-sensor-offline'
  | 'camera-sensor-unsupported'
  | 'camera-sensor-unreadable'

export interface CameraProblem {
  readonly code: CameraProblemCode
  readonly severity: CameraProblemSeverity
  readonly message: string
}

/**
 * Derive the list of operational problems for one camera. Errors first,
 * then warnings — callers can rely on the ordering for display.
 */
export function deriveCameraProblems(status: CameraStatus): readonly CameraProblem[] {
  const errors: CameraProblem[] = []
  const warnings: CameraProblem[] = []
  const { assignment, detection, broker } = status

  if (detection !== null && detection.provisioning.state === 'failed') {
    errors.push({
      code: 'provisioning-failed',
      severity: 'error',
      message:
        detection.provisioning.error !== undefined && detection.provisioning.error.length > 0
          ? i18n.t('helpers.cameraCardModel.provisioningFailedWith', {
              error: detection.provisioning.error,
            })
          : i18n.t('helpers.cameraCardModel.provisioningFailed'),
    })
  }

  // Cross-node black-hole signature: the runner reports an ACTIVE detection
  // phase but zero frames per second are actually being processed. The
  // pipeline believes it is running while no frames arrive — typically a
  // broken cross-node frame plane. This camera must not look healthy.
  if (detection !== null && detection.phase === 'active' && detection.actualFps === 0) {
    errors.push({
      code: 'detection-black-hole',
      severity: 'error',
      message: i18n.t('helpers.cameraCardModel.blackHole'),
    })
  }

  // An ARMED on-motion camera has the identical shape (no detection node, no
  // detection block) and is healthy — it is dispatched per motion event and
  // holds no standing assignment in between. Claiming "no pipeline is running"
  // there is the same inversion as calling an unreadable camera broken.
  if (assignment.detectionNodeId === null && detection === null && !isArmedCamera(status)) {
    warnings.push({
      code: 'unassigned',
      severity: 'warning',
      message: i18n.t('helpers.cameraCardModel.unassigned'),
    })
  }

  // Stages the server could not READ. This is a gap, not a fault: the blocks
  // they would have filled are `null` and `switchedOff` may be a floor rather
  // than a total, so nothing below may be concluded from them. Reported as a
  // WARNING on purpose — calling an unreadable camera broken is precisely the
  // inversion this marker exists to prevent (a camera whose switch read timed
  // out is very often one the operator switched OFF).
  //
  // `?? []` is not defensive noise: the router is a structural pass-through
  // that does not re-validate output, and the orchestrator addon is deployed
  // separately from this UI — between the two deploys a payload arrives
  // without the field, and a roster that throws is worse than one that has
  // nothing to say.
  const degraded = status.degraded ?? []
  if (degraded.length > 0) {
    const stages = [...new Set(degraded.map((d) => d.stage))].join(', ')
    warnings.push({
      code: 'status-unreadable',
      severity: 'warning',
      message: i18n.t('helpers.cameraCardModel.statusUnreadable', { stages }),
    })
  }

  warnings.push(...cameraSensorProblems(status.cameraSensors))

  for (const profile of broker?.profiles ?? []) {
    if (profile.status === 'streaming' && profile.inFps === 0) {
      warnings.push({
        code: 'broker-stalled',
        severity: 'warning',
        message: i18n.t('helpers.cameraCardModel.brokerStalled', { profile: profile.profile }),
      })
    }
  }

  return [...errors, ...warnings]
}

// ---------------------------------------------------------------------------
// Camera sensors (D672)
// ---------------------------------------------------------------------------

/**
 * The boot window: the orchestrator has not answered its first settings read
 * for this camera yet. Normal, short, and not a fault — never a warning.
 */
function isNotLoaded(status: CameraSensorsStatus): boolean {
  return (
    status.state === 'unreadable' &&
    CAMERA_SENSORS_NOT_LOADED.state === 'unreadable' &&
    status.reason === CAMERA_SENSORS_NOT_LOADED.reason
  )
}

function attachmentProblem(sensor: CameraSensorAttachment): CameraProblem | null {
  switch (sensor.state) {
    case 'ready':
      return null
    case 'missing':
      return {
        code: 'camera-sensor-missing',
        severity: 'warning',
        message: i18n.t('helpers.cameraCardModel.sensorMissing', {
          addonId: sensor.addonId,
          stableId: sensor.stableId,
        }),
      }
    case 'offline':
      return {
        code: 'camera-sensor-offline',
        severity: 'warning',
        message: i18n.t('helpers.cameraCardModel.sensorOffline', {
          name: sensor.name,
          deviceId: sensor.deviceId,
          reason: sensor.reason,
        }),
      }
    case 'unsupported':
      return {
        code: 'camera-sensor-unsupported',
        severity: 'warning',
        message: i18n.t('helpers.cameraCardModel.sensorUnsupported', {
          name: sensor.name,
          deviceId: sensor.deviceId,
          reason: sensor.reason,
        }),
      }
    case 'unreadable':
      return {
        code: 'camera-sensor-unreadable',
        severity: 'warning',
        message: i18n.t('helpers.cameraCardModel.sensorUnreadable', {
          addonId: sensor.addonId,
          stableId: sensor.stableId,
          reason: sensor.reason,
        }),
      }
  }
}

/**
 * One warning per attachment that cannot drive motion. `undefined` (an older
 * orchestrator that sent no field) adds nothing: that node gave no answer, and
 * the card's row says so rather than a warning guessing at it (D315).
 */
function cameraSensorProblems(status: CameraSensorsStatus | undefined): readonly CameraProblem[] {
  if (status === undefined || status.state === 'not-configured') return []
  if (status.state === 'unreadable') {
    if (isNotLoaded(status)) return []
    return [
      {
        code: 'camera-sensors-unreadable',
        severity: 'warning',
        message: i18n.t('helpers.cameraCardModel.sensorsUnreadable', { reason: status.reason }),
      },
    ]
  }
  const attachments = status.sensors.flatMap((sensor) => {
    const problem = attachmentProblem(sensor)
    return problem === null ? [] : [problem]
  })
  const forwarded =
    status.notForwarded === undefined
      ? attachments
      : [notForwardedProblem(status.notForwarded), ...attachments]
  return status.notEnforced === undefined
    ? forwarded
    : [
        {
          code: 'camera-sensors-not-enforced',
          severity: 'warning',
          message: i18n.t('helpers.cameraCardModel.notEnforced'),
        },
        ...forwarded,
      ]
}

/**
 * A configured camera whose sensors can never fire, however ready they read:
 * the orchestrator's bridge drops every rise (D672). Ready must not look like
 * working (the D62 direction).
 */
function notForwardedProblem(reason: CameraSensorsNotForwarded): CameraProblem {
  return {
    code: 'camera-sensors-not-forwarded',
    severity: 'warning',
    message:
      reason === 'onboard-not-listed'
        ? i18n.t('helpers.cameraCardModel.notForwardedOnboard')
        : i18n.t('helpers.cameraCardModel.notForwardedNoDetection'),
  }
}

/**
 * The card's "Camera sensors" row. Three different absences stay three:
 * nothing attached, not known yet, and a node that does not report it.
 */
export function cameraSensorsSummary(status: CameraSensorsStatus | undefined): string {
  if (status === undefined) return i18n.t('helpers.cameraCardModel.summaryUnavailable')
  if (status.state === 'not-configured') return i18n.t('helpers.cameraCardModel.summaryNone')
  if (status.state === 'unreadable')
    return i18n.t('helpers.cameraCardModel.summaryUnknown', { reason: status.reason })
  return status.sensors.map(attachmentSummary).join(', ')
}

/** A non-default mode is named; in addition is the default and says nothing (D673). */
function modeSuffix(sensor: CameraSensorAttachment): string {
  return sensor.mode === 'in-addition' ? '' : ` · ${sensor.mode}`
}

function attachmentSummary(sensor: CameraSensorAttachment): string {
  return `${attachmentText(sensor)}${modeSuffix(sensor)}`
}

function attachmentText(sensor: CameraSensorAttachment): string {
  switch (sensor.state) {
    case 'ready':
      return `${sensor.name} (#${sensor.deviceId})`
    case 'offline':
      return `${sensor.name} (#${sensor.deviceId}) — ${sensor.reason}`
    case 'unsupported':
      return i18n.t('helpers.cameraCardModel.summaryUnsupported', {
        name: sensor.name,
        deviceId: sensor.deviceId,
      })
    case 'missing':
    case 'unreadable':
      return `${sensor.addonId}/${sensor.stableId} — ${sensor.state}`
  }
}

// ---------------------------------------------------------------------------
// Orchestrator per-camera settings extraction
// ---------------------------------------------------------------------------

export interface OrchestratorCameraSettings {
  /** `disabled` | `always-on` | `on-motion` — null while the schema loads. */
  readonly detectionMode: string | null
  readonly detectionStreamProfile: string | null
  /** 0 = no throttle (decoder native rate); null = inherit default. */
  readonly detectionFps: number | null
  readonly motionSources: readonly string[]
  readonly motionFps: number | null
  readonly motionCooldownMs: number | null
  readonly motionStreamProfile: string | null
  readonly audioMode: string | null
  /** Persisted node pins from settings — `'auto'` means load-balanced. */
  readonly pipelineNodeId: string | null
  readonly decoderNodeId: string | null
  readonly audioNodeId: string | null
  /**
   * Settings keys whose persisted value differs from the schema default —
   * i.e. an operator override is active for this camera. Null-valued fields
   * ("Default" on nullable sliders) never count as overrides.
   */
  readonly overriddenKeys: ReadonlySet<string>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

function valueDiffers(value: unknown, defaultValue: unknown): boolean {
  // Null/undefined value means "inherit default" — never an override.
  if (value === null || value === undefined) return false
  return JSON.stringify(value) !== JSON.stringify(defaultValue ?? null)
}

const EMPTY_SETTINGS: OrchestratorCameraSettings = {
  detectionMode: null,
  detectionStreamProfile: null,
  detectionFps: null,
  motionSources: [],
  motionFps: null,
  motionCooldownMs: null,
  motionStreamProfile: null,
  audioMode: null,
  pipelineNodeId: null,
  decoderNodeId: null,
  audioNodeId: null,
  overriddenKeys: new Set<string>(),
}

/**
 * Extract the operationally relevant per-camera parameters from the
 * orchestrator's hydrated device-settings payload
 * (`addonSettings.getDeviceSettings`). Structural over `unknown` — returns
 * the loading-state placeholder (all null / empty) when the payload is
 * missing or malformed.
 */
export function extractOrchestratorCameraSettings(schema: unknown): OrchestratorCameraSettings {
  if (!isRecord(schema) || !Array.isArray(schema['sections'])) return EMPTY_SETTINGS

  // Shared framework primitive — flattens the hydrated schema (groups +
  // sub-tabs) into key → { value, default }; replaces the addon-local walker.
  const entries = collectHydratedFieldEntries(schema)

  const resolve = (key: string): unknown => {
    const entry = entries.get(key)
    if (entry === undefined) return undefined
    return entry.value ?? entry.default
  }

  const overriddenKeys = new Set<string>()
  for (const [key, entry] of entries) {
    if (valueDiffers(entry.value, entry.default)) overriddenKeys.add(key)
  }

  return {
    detectionMode: asString(resolve('detectionMode')),
    detectionStreamProfile: asString(resolve('detectionStreamProfile')),
    detectionFps: asNumber(resolve('detectionFps')),
    motionSources: asStringArray(resolve('motionSources')),
    motionFps: asNumber(resolve('motionFps')),
    motionCooldownMs: asNumber(resolve('motionCooldownMs')),
    motionStreamProfile: asString(resolve('motionStreamProfile')),
    audioMode: asString(resolve('audioMode')),
    pipelineNodeId: asString(resolve('pipelineNodeId')),
    decoderNodeId: asString(resolve('decoderNodeId')),
    audioNodeId: asString(resolve('audioNodeId')),
    overriddenKeys,
  }
}

// ---------------------------------------------------------------------------
// Resolved pipeline steps flattening
// ---------------------------------------------------------------------------

export interface FlatPipelineStep {
  readonly addonId: string
  readonly modelId: string | null
  readonly enabled: boolean
  /** Nesting depth in the resolved step tree (0 = root detector). */
  readonly depth: number
}

/** Flatten the resolved step tree into display rows, preserving order. */
export function flattenPipelineSteps(
  steps: readonly PipelineStepInputOutput[],
  depth = 0,
): readonly FlatPipelineStep[] {
  const rows: FlatPipelineStep[] = []
  for (const step of steps) {
    rows.push({
      addonId: step.addonId,
      modelId: step.modelId ?? null,
      enabled: step.enabled,
      depth,
    })
    if (step.children !== undefined && step.children.length > 0) {
      rows.push(...flattenPipelineSteps(step.children, depth + 1))
    }
  }
  return rows
}
