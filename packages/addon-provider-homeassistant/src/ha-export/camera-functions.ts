/**
 * The eight per-camera functions, derived from the AUTHORITIES that already own them
 * ([D62](../../../../docs/decisions/adr-0062.md),
 * [D113](../../../../docs/decisions/adr-0113.md)).
 *
 * This module stores nothing and normalizes nothing. It is the pure reading
 * of eight answers, exactly as
 * `addon-admin-ui/.../camera-function-switches.ts` is of its three — which is the
 * MODEL, not a dependency: addons do not import each other.
 *
 * The labels are copied verbatim from `CAMERA_SWITCH_CATALOG` because they are the
 * friendly names the entities ALREADY have in Home Assistant. They live here and not
 * there because phase 4 of D113 deletes that catalog; `CameraSwitchId` instead
 * survives, it is the vocabulary of `CameraStatus.switchedOff`.
 *
 * The rule for which `null`s exist: **a source that has not answered is
 * unknown, never a value set to "on"**.
 */
import type { CameraSwitchId } from '@camstack/types'

export interface CameraFunctionReads {
  /** `deviceManager.listAll()` → `disabled`. `null` = lettura fallita. */
  readonly deviceDisabled: boolean | null
  /** `deviceManager.listBindableCapsForDeviceType({ deviceType })`. */
  readonly bindableCapNames: readonly string[] | null
  /** `deviceManager.getBindings()` → entries con `kind: 'wrapped'`. */
  readonly wrappedCapNames: readonly string[] | null
  /** cap → addon that must appear in `setWrapperActive`. */
  readonly wrapperAddonIdByCap: ReadonlyMap<string, string>
  /** `recording.getDeviceConfig()` → `enabled`. */
  readonly recordingEnabled: boolean | null
  /** `notificationRules.listDeviceMutes()` ∋ deviceId. */
  readonly notificationsMuted: boolean | null
  /** The `privacy-mask` slice already in the snapshot. `null` = cap not present. */
  readonly privacy: CameraPrivacyReads | null
  /** `streamBroker.getDeviceAudioMute()` → `muted`. */
  readonly brokerAudioMuted: boolean | null
}

export interface CameraPrivacyReads {
  readonly maskEnabled: boolean
  /** `null` = this camera has no writable microphone, or has not answered. */
  readonly audioEnabled: boolean | null
}

export interface CameraFunction {
  readonly id: CameraSwitchId
  /** The friendly name the entity already has in HA. Renaming it is a migration. */
  readonly label: string
  readonly available: boolean
  /** Meaningless when `available` is false. */
  readonly enabled: boolean
}

export type CameraFunctionWrite =
  | { readonly kind: 'device-disabled'; readonly disabled: boolean }
  | {
      readonly kind: 'wrapper-binding'
      readonly capName: string
      readonly wrapperAddonId: string
      readonly active: boolean
    }
  | { readonly kind: 'recording-enabled'; readonly enabled: boolean }
  | { readonly kind: 'notification-mute'; readonly muted: boolean }
  | { readonly kind: 'camera-mask'; readonly enabled: boolean }
  | { readonly kind: 'camera-audio'; readonly enabled: boolean }
  | { readonly kind: 'broker-audio-mute'; readonly muted: boolean }

const DETECTION_CAP = 'detection-pipeline'
const AUDIO_ANALYSIS_CAP = 'audio-analysis'
/** The wrapper that WRITES the history: tracks, events and their media. */
const PIPELINE_ANALYTICS_CAP = 'pipeline-analytics'

/** Render order: widest reach first, source before consumer. */
const ORDER: readonly CameraSwitchId[] = [
  'stream-broker',
  'object-detection',
  'privacy-mask',
  'device-audio',
  'broker-audio',
  'audio-analysis',
  'event-saving',
  'recording',
  'notifications',
]

const LABELS: Readonly<Record<CameraSwitchId, string>> = {
  'stream-broker': 'Camera',
  'object-detection': 'Object detection & tracking',
  'privacy-mask': 'Privacy mask',
  'device-audio': 'Camera microphone',
  'broker-audio': 'Audio distribution',
  'audio-analysis': 'Audio detection & classification',
  'event-saving': 'Event saving',
  recording: 'Recording',
  notifications: 'Notifications',
}

/**
 * Which cap stands behind each wrapper-backed switch. A map instead of a
 * ternary: with three entries the ternary became a chain, and the next entry
 * would have silently landed on the wrong branch.
 */
const WRAPPER_CAP_BY_ID: Readonly<
  Record<'object-detection' | 'audio-analysis' | 'event-saving', string>
> = {
  'object-detection': DETECTION_CAP,
  'audio-analysis': AUDIO_ANALYSIS_CAP,
  'event-saving': PIPELINE_ANALYTICS_CAP,
}

interface Resolved {
  readonly available: boolean
  readonly enabled: boolean
}

const UNAVAILABLE: Resolved = { available: false, enabled: true }

function resolveWrapper(capName: string, reads: CameraFunctionReads): Resolved {
  if (reads.bindableCapNames === null || reads.wrappedCapNames === null) return UNAVAILABLE
  if (!reads.bindableCapNames.includes(capName)) return UNAVAILABLE
  if (reads.wrapperAddonIdByCap.get(capName) === undefined) return UNAVAILABLE
  return { available: true, enabled: reads.wrappedCapNames.includes(capName) }
}

function resolveOne(id: CameraSwitchId, reads: CameraFunctionReads): Resolved {
  switch (id) {
    case 'stream-broker':
      return reads.deviceDisabled === null
        ? UNAVAILABLE
        : { available: true, enabled: !reads.deviceDisabled }
    case 'object-detection':
      return resolveWrapper(DETECTION_CAP, reads)
    case 'audio-analysis':
      return resolveWrapper(AUDIO_ANALYSIS_CAP, reads)
    case 'event-saving':
      return resolveWrapper(PIPELINE_ANALYTICS_CAP, reads)
    case 'recording':
      return reads.recordingEnabled === null
        ? UNAVAILABLE
        : { available: true, enabled: reads.recordingEnabled }
    case 'notifications':
      return reads.notificationsMuted === null
        ? UNAVAILABLE
        : { available: true, enabled: !reads.notificationsMuted }
    case 'privacy-mask':
      // Polarity NOT inverted: `on` = the mask is obscuring.
      return reads.privacy === null
        ? UNAVAILABLE
        : { available: true, enabled: reads.privacy.maskEnabled }
    case 'device-audio':
      return reads.privacy === null || reads.privacy.audioEnabled === null
        ? UNAVAILABLE
        : { available: true, enabled: reads.privacy.audioEnabled }
    case 'broker-audio':
      // Inverted polarity: the switch is "audio is being distributed".
      return reads.brokerAudioMuted === null
        ? UNAVAILABLE
        : { available: true, enabled: !reads.brokerAudioMuted }
  }
}

export function deriveCameraFunctions(reads: CameraFunctionReads): readonly CameraFunction[] {
  return ORDER.map((id) => ({ id, label: LABELS[id], ...resolveOne(id, reads) }))
}

/** `null` = not available: the write must be REFUSED, not approximated. */
export function resolveCameraFunctionWrite(
  id: CameraSwitchId,
  on: boolean,
  reads: CameraFunctionReads,
): CameraFunctionWrite | null {
  if (!resolveOne(id, reads).available) return null
  switch (id) {
    case 'stream-broker':
      return { kind: 'device-disabled', disabled: !on }
    case 'object-detection':
    case 'audio-analysis':
    case 'event-saving': {
      const capName = WRAPPER_CAP_BY_ID[id]
      const wrapperAddonId = reads.wrapperAddonIdByCap.get(capName)
      if (wrapperAddonId === undefined) return null
      return { kind: 'wrapper-binding', capName, wrapperAddonId, active: on }
    }
    case 'recording':
      return { kind: 'recording-enabled', enabled: on }
    case 'notifications':
      return { kind: 'notification-mute', muted: !on }
    case 'privacy-mask':
      return { kind: 'camera-mask', enabled: on }
    case 'device-audio':
      return { kind: 'camera-audio', enabled: on }
    case 'broker-audio':
      return { kind: 'broker-audio-mute', muted: !on }
  }
}
