/**
 * Pure device-detection-settings derivation for the pipeline orchestrator.
 *
 * Extracted from `index.ts`'s `resolveDeviceDetectionSettings` (S3 refactor
 * step — zero behavior change). That ~185-line method interleaved I/O
 * (device-store read, binding/feature lookups) with a 5-branch
 * `motionSources` default ladder and several other operator-wins→profile→
 * fallback resolutions. The class-side method now does ONLY the I/O
 * gathering (`readDeviceStore`, `hydrateSchema`, `lookupDeviceFeatures`,
 * `deviceHasOnboardMotionCap`, `isDetectionPipelineActive`,
 * `isMotionDetectionActive`) and hands the raw materials to
 * `resolveDetectionSettings`, the pure decision half that used to be
 * interleaved with that I/O.
 *
 * Also carries:
 *  - `resolveAssignedProfile` — the profile-slot fallback chain (was already
 *    pure; moved verbatim, no `this` usage in the original).
 *  - `detectionConfigEquals` — the field-by-field `CameraDetectionConfig`
 *    comparator (was already a pure `static`; moved verbatim).
 *  - `buildDetectionConfigFromInputs` — the pure tail of
 *    `buildDetectionConfig`: given the resolved settings + the assigned
 *    profile-slot map, resolves motion/detection profiles and shapes the
 *    `CameraDetectionConfig` result.
 *  - `buildRunnerConfig` — a single-source-of-truth `RunnerCameraConfig`
 *    literal builder (smell #10: the literal was built field-by-field in 3
 *    places — `startDetection`, `ensureMotionWatch`,
 *    `dispatchDetectionSession` — differing only in `motionSources` /
 *    `detectionMode` / `audioMode` / `steps` / `audio`). Wired ONLY into
 *    `startDetection`'s always-on/config-build branch in this step; the two
 *    Phase-3 session-time sites intentionally still build their own literals
 *    inline — a later refactor step migrates them so this step never touches
 *    the session-dispatch path.
 */
import { type AudioStreamPick, toAudioStreamPick } from './audio-stream-selection.js'
import type {
  CameraDetectionConfig,
  CamProfile,
  MotionSource,
  DetectionSources,
  MotionSources,
  PipelinePhaseMode,
  PipelineStepInputOutput,
  RunnerCameraConfig,
  Zone,
} from '@camstack/types'
import {
  DeviceFeature,
  DetectionSourcesSchema,
  MotionSourcesSchema,
  RunnerCameraDeviceUIFields,
  resolveDeviceProfile,
} from '@camstack/types'
import { DEVICE_ACTIVITY_SOURCE } from './device-activity-source.js'
import { isPipelinePhaseMode } from './orchestrator-types.js'

// ── resolveDetectionSettings ──────────────────────────────────────────────

/**
 * Raw materials the class gathers via I/O before calling the pure
 * resolver. `raw` is the unhydrated per-device settings store (used to
 * distinguish "operator explicitly set this key" from "schema default
 * fired"); `flat` is the same store hydrated with schema defaults so every
 * leaf field has a concrete value.
 */
export interface ResolveDetectionSettingsInput {
  readonly deviceId: number
  readonly raw: Record<string, unknown>
  readonly flat: Record<string, unknown>
  readonly features: readonly string[]
  readonly hasOnboardMotion: boolean
  /**
   * True when the device's driver registered `recording-signal` — i.e. the
   * device can say, itself, that it is working. Drives the `device-activity`
   * entry in the `motionSources` DEFAULT (D392): expressed here, per device,
   * so it reaches the robot and no camera that cannot report the fact.
   */
  readonly hasActivitySignal: boolean
  readonly pipelineEnabled: boolean
  readonly motionDetectionEnabled: boolean
}

export interface ResolvedDetectionSettings {
  readonly motionDetectionEnabled: boolean
  readonly pipelineEnabled: boolean
  readonly motionSources: MotionSources
  /** Which root detectors this camera runs. Never defaulted to the camera's
   *  own — a vendor's detector is used because an operator picked it. */
  readonly detectionSources: DetectionSources
  readonly motionStreamProfile: CamProfile
  readonly detectionStreamProfile: CamProfile
  readonly motionFps: number
  readonly detectionFps: number
  /** The cap `detectionFpsForTrigger` applies to a device-activity session. */
  readonly activityDetectionFps: number
  readonly motionCooldownMs: number
  readonly maxSessionHoldMs: number
  readonly audioMotionWindowMs: number
  /** Which rung audio listens on — `auto` (the default) or an explicit rung. */
  readonly audioStreamPick: AudioStreamPick
  readonly detectionMode: PipelinePhaseMode
  readonly audioMode: PipelinePhaseMode
  readonly onboardMotionDrivesAnalyzer: boolean
  readonly occupancyRecheckEnabled: boolean
  readonly occupancyRecheckSec: number
  readonly occupancyRecheckFrames: number
  /** Whether the session's decoded PRE-ROLL is inferred rather than dropped as
   *  stale (D411). Defaulted here, not read from a settings field: the runner
   *  cap owns the default and this orchestrator only has to carry it. */
  readonly preRollInferenceEnabled: boolean
  readonly preRollInferenceFrames: number
}

/** Read a required string leaf out of the hydrated `flat` schema values. */
function mustString(flat: Record<string, unknown>, deviceId: number, key: string): string {
  const v = flat[key]
  if (typeof v !== 'string')
    throw new Error(`orchestrator schema missing required string '${key}' for device ${deviceId}`)
  return v
}

/** Read a required number leaf out of the hydrated `flat` schema values. */
function mustNumber(flat: Record<string, unknown>, deviceId: number, key: string): number {
  const v = flat[key]
  if (typeof v !== 'number')
    throw new Error(`orchestrator schema missing required number '${key}' for device ${deviceId}`)
  return v
}

/**
 * Nullable ("Default") sliders resolve a null/unset value to the field's UI
 * default at dispatch — so the runner always receives a concrete number
 * while the operator can pick "Default" to track it (null in the store).
 */
function numberOrDefault(flat: Record<string, unknown>, key: string): number {
  const v = flat[key]
  // `detectionFps: 0` was the former orchestrator-specific "native rate"
  // default. The runner capability has always defined 10 fps as its safe
  // default, and the session decoder now enforces that limit before RGB/IPC.
  // Treat persisted zeroes as the legacy default so existing cameras migrate
  // without continuing to decode every source frame indefinitely.
  if (typeof v === 'number' && (key !== 'detectionFps' || v > 0)) return v
  const uiField = RunnerCameraDeviceUIFields.find((f) => f.key === key)
  const dflt = uiField && 'default' in uiField ? uiField.default : undefined
  return typeof dflt === 'number' ? dflt : 0
}

/**
 * Frames per second a `device-activity` session is allowed, when the operator
 * has not picked a value.
 *
 * The arithmetic this defends: a whole-house cleaning run is ~40 minutes of
 * continuous activity — 2 400 s. At the camera default of 10 fps that session
 * would ask for **24 000 inferences** to find a cat that walks past once. At
 * 1 fps it asks for 2 400, a 10× cut, and a person crossing a room (2–4 s in
 * frame) still gets 2–4 chances to be seen — enough for the tracker to confirm.
 * Below 1 fps a crossing subject gets one frame or none, which is a detection
 * the tracker discards, so the saving would buy nothing. The robot is also the
 * thing moving, so frame-to-frame association is weak regardless and extra
 * frames do not buy proportional recall.
 */
export const ACTIVITY_DETECTION_FPS_DEFAULT = 1

/** The activity rate from the hydrated store, or the shipped default. */
function activityFps(flat: Record<string, unknown>): number {
  const v = flat['activityDetectionFps']
  return typeof v === 'number' && v > 0 ? v : ACTIVITY_DETECTION_FPS_DEFAULT
}

/**
 * The detection rate a session opens at, given WHAT OPENED IT.
 *
 * A CAP, not a set: `min(cameraRate, activityRate)`. A camera already slower
 * than the activity rate stays slower, so lowering the global rate keeps
 * working. Why this lever and not the other two: a per-device `detectionFps`
 * would also slow the sessions a real motion trigger opens on the same camera,
 * and it becomes silently wrong the day the device gains a second trigger; a
 * per-SOURCE rate table would have to reach the runner and be re-applied
 * whenever the source holding the session changes, which the attach-time config
 * cannot express. Scoping it to the session's TRIGGER puts the number exactly
 * where its justification lives.
 *
 * Applies to the session the activity level OPENS. A session already open at
 * the camera rate when the level rises is not re-attached to slow it down —
 * re-attaching a live session to change one number costs a decode restart.
 */
export function detectionFpsForTrigger(
  config: Pick<CameraDetectionConfig, 'detectionFps' | 'activityDetectionFps'>,
  trigger: MotionSource | undefined,
): number {
  if (trigger !== DEVICE_ACTIVITY_SOURCE) return config.detectionFps
  return Math.min(
    config.detectionFps,
    config.activityDetectionFps ?? ACTIVITY_DETECTION_FPS_DEFAULT,
  )
}

/**
 * Pure decision/derivation half of the former `resolveDeviceDetectionSettings`.
 * Given the I/O-gathered raw materials, resolves every operator-wins →
 * profile-default → static-fallback field. Throws on a malformed device
 * schema (missing required leaf, invalid enum value) — the class-side
 * caller wraps this in a try/catch and returns `null` on failure, matching
 * the original method's "narrowing failed" catch.
 */
export function resolveDetectionSettings(
  input: ResolveDetectionSettingsInput,
): ResolvedDetectionSettings {
  const {
    deviceId,
    raw,
    flat,
    features,
    hasOnboardMotion,
    hasActivitySignal,
    pipelineEnabled,
    motionDetectionEnabled,
  } = input

  // Resolve the device profile (battery / future low-bandwidth /
  // always-on-AC) once so we can layer profile defaults under the
  // operator's persisted choices. Profile defaults fire only when the
  // operator hasn't picked a value — concrete operator entries in the
  // device store always win.
  const profile = resolveDeviceProfile(features)

  // Universal motion-source default: operator-set value wins; else prefer
  // firmware/onboard motion when the device exposes the cap; else fall back
  // to the SW analyzer.
  //
  // The "onboard preferred" rule is cross-profile, not battery-specific —
  // non-battery cams with firmware motion (Reolink RLC-X wired, ONVIF
  // analytics) also default to `['onboard']` so we
  // don't burn CPU running a redundant SW analyzer.
  //
  // Battery cams without firmware motion get `[]` instead of `['analyzer']`
  // because running SW motion on a battery cam would hold the substream
  // open continuously and defeat the sleep cycle. Operator opts into
  // `'analyzer'` explicitly.
  // A device that can report its OWN activity carries `device-activity` in its
  // default (D392) — the robot vacuum whose camera exists only while it works
  // would otherwise sit at `[]` (battery branch) and be analysed never. It is
  // ADDED to whatever the rest of the ladder picks rather than replacing it: a
  // device with both firmware motion and an activity signal has two real
  // triggers. An explicit operator list still wins in both directions,
  // including an empty one — the source is removable.
  // WHICH root detector, and no ladder: unlike `motionSources` there is no
  // device fact that makes the camera's own detector the right choice — a
  // firmware that CAN detect is not a firmware the operator wants detecting.
  // So the only default is `['pipeline']`, and everything else is a pick.
  const userDetectionSources = raw['detectionSources']
  const detectionSources: DetectionSources =
    userDetectionSources !== undefined
      ? DetectionSourcesSchema.parse(userDetectionSources)
      : ['pipeline']

  const userMotionSources = raw['motionSources']
  let motionSources: MotionSources
  if (userMotionSources !== undefined) {
    motionSources = MotionSourcesSchema.parse(userMotionSources)
  } else {
    let defaulted: MotionSources
    if (hasOnboardMotion) {
      defaulted = ['onboard']
    } else if (hasActivitySignal) {
      // Not the battery `[]` and not the analyzer: a device that says when it
      // is working needs neither a guess nor a frame-diff to know when to look.
      defaulted = []
    } else if (profile && features.includes(DeviceFeature.BatteryOperated)) {
      defaulted = []
    } else {
      defaulted = MotionSourcesSchema.parse(flat['motionSources'])
    }
    motionSources = hasActivitySignal ? [...defaulted, DEVICE_ACTIVITY_SOURCE] : defaulted
  }

  // Mode resolution: operator-set value wins; profile default fires when
  // the operator hasn't picked; static fallback when neither matches.
  const userDetectionMode = raw['detectionMode']
  const detectionMode: PipelinePhaseMode =
    typeof userDetectionMode === 'string' && isPipelinePhaseMode(userDetectionMode)
      ? userDetectionMode
      : (profile?.defaults.detectionMode ?? 'on-motion')
  // Absent (and anything unrecognised) reads as `auto` — the lowest AVAILABLE
  // native rung, which is what every camera already does. `toAudioStreamPick`
  // is the only narrowing; a stored value is never trusted as a rung.
  const audioStreamPick = toAudioStreamPick(raw['audioStreamPick'])

  const userAudioMode = raw['audioMode']
  const audioMode: PipelinePhaseMode =
    typeof userAudioMode === 'string' && isPipelinePhaseMode(userAudioMode)
      ? userAudioMode
      : (profile?.defaults.audioMode ?? 'always-on')

  // Operator-set value wins; default true when unset.
  const userOnboardMotionDrivesAnalyzer = raw['onboardMotionDrivesAnalyzer']
  const onboardMotionDrivesAnalyzer: boolean =
    typeof userOnboardMotionDrivesAnalyzer === 'boolean' ? userOnboardMotionDrivesAnalyzer : true

  // Operator-set value wins; default TRUE (2026-08-13 — was false).
  //
  // A stationary object is only counted while the stationary registry holds it,
  // and that registry rebuilds FROM MOTION after a restart. With the recheck
  // off, a parked car was invisible to every occupancy rule until something
  // moved in front of it — on a quiet driveway, indefinitely. The periodic
  // re-sample is the only thing that looks at a still scene.
  //
  // The cost (a session re-subscribe ⇒ an RTSP re-dial per cycle) is paid on
  // the INTERVAL instead: `occupancyRecheckSecField.default` is deliberately
  // wide. Per-camera override still wins in both directions.
  //
  // This default is the EFFECTIVE one: `flat` is hydrated from the schema this
  // addon contributes, and the value the runner receives is the one resolved
  // here — so flipping it ships with an orchestrator deploy, no train.
  const userOccupancyRecheckEnabled = raw['occupancyRecheckEnabled']
  const occupancyRecheckEnabled: boolean =
    typeof userOccupancyRecheckEnabled === 'boolean' ? userOccupancyRecheckEnabled : true

  const occupancyRecheckSec = mustNumber(flat, deviceId, 'occupancyRecheckSec')
  const occupancyRecheckFrames = mustNumber(flat, deviceId, 'occupancyRecheckFrames')

  // Pre-roll inference (D411). Read as an OVERRIDE, never as a required leaf:
  // the field is not in this addon's settings schema, so `mustNumber` would
  // throw on every camera. Same shape as `occupancyRecheckEnabled` above —
  // absent means the cap's own default, which is what ships.
  const userPreRollEnabled = raw['preRollInferenceEnabled']
  const preRollInferenceEnabled: boolean =
    typeof userPreRollEnabled === 'boolean' ? userPreRollEnabled : true
  const userPreRollFrames = raw['preRollInferenceFrames']
  const preRollInferenceFrames: number =
    typeof userPreRollFrames === 'number' && Number.isFinite(userPreRollFrames)
      ? userPreRollFrames
      : 12

  return {
    motionDetectionEnabled,
    pipelineEnabled,
    motionSources,
    detectionSources,
    // Deliberate pass-through boundary (documented type-boundary cast, not a
    // raw `as any`): the write path does not enforce the CamProfile enum on
    // a stored value, and `resolveAssignedProfile` already tolerates a
    // non-enum profile via its else-branch fallback. Parsing/throwing here
    // would turn a malformed stored value into a hard failure that aborts
    // detection entirely for the device — strictly worse than the
    // pre-existing pass-through behavior this preserves.
    motionStreamProfile: mustString(flat, deviceId, 'motionStreamProfile') as CamProfile,
    detectionStreamProfile: mustString(flat, deviceId, 'detectionStreamProfile') as CamProfile,
    motionFps: numberOrDefault(flat, 'motionFps'),
    detectionFps: numberOrDefault(flat, 'detectionFps'),
    activityDetectionFps: activityFps(flat),
    motionCooldownMs: numberOrDefault(flat, 'motionCooldownMs'),
    maxSessionHoldMs: numberOrDefault(flat, 'maxSessionHoldMs'),
    audioMotionWindowMs: numberOrDefault(flat, 'audioMotionWindowMs'),
    audioStreamPick,
    detectionMode,
    audioMode,
    onboardMotionDrivesAnalyzer,
    occupancyRecheckEnabled,
    occupancyRecheckSec,
    occupancyRecheckFrames,
    preRollInferenceEnabled,
    preRollInferenceFrames,
  }
}

// ── resolveAssignedProfile ────────────────────────────────────────────────

/**
 * Resolve the requested profile against the set of currently-assigned
 * profile slots. Returns the profile id itself if the slot is live;
 * otherwise walks the quality chain so a device missing the requested
 * profile still gets a detection subscription on the closest assigned
 * slot. Returns `null` only when nothing is assigned.
 */
export function resolveAssignedProfile(
  assigned: ReadonlyMap<CamProfile, string>,
  profile: CamProfile,
): CamProfile | null {
  if (assigned.has(profile)) return profile
  if (profile === 'low') {
    if (assigned.has('mid')) return 'mid'
    if (assigned.has('high')) return 'high'
    return null
  }
  if (profile === 'high') {
    if (assigned.has('mid')) return 'mid'
    if (assigned.has('low')) return 'low'
    return null
  }
  if (assigned.has('high')) return 'high'
  if (assigned.has('low')) return 'low'
  return null
}

// ── buildDetectionConfigFromInputs ────────────────────────────────────────

/**
 * Pure tail of `buildDetectionConfig`: given the already-resolved per-device
 * settings and the device's currently-assigned profile-slot map, resolves
 * the motion/detection profiles (via `resolveAssignedProfile`) and shapes
 * the `CameraDetectionConfig` the dispatch path consumes. Returns `null`
 * when either profile — or its backing cam-stream id — isn't assigned.
 */
export function buildDetectionConfigFromInputs(
  resolved: ResolvedDetectionSettings,
  assigned: ReadonlyMap<CamProfile, string>,
): CameraDetectionConfig | null {
  const motionProfile = resolveAssignedProfile(assigned, resolved.motionStreamProfile)
  const detectionProfile = resolveAssignedProfile(assigned, resolved.detectionStreamProfile)
  if (!motionProfile || !detectionProfile) return null
  const motionCamStreamId = assigned.get(motionProfile)
  const detectionCamStreamId = assigned.get(detectionProfile)
  if (!motionCamStreamId || !detectionCamStreamId) return null

  return {
    enabled: resolved.motionDetectionEnabled,
    pipelineEnabled: resolved.pipelineEnabled,
    motionSources: resolved.motionSources,
    detectionSources: resolved.detectionSources,
    motionStreamId: motionCamStreamId,
    detectionStreamId: detectionCamStreamId,
    motionFps: resolved.motionFps,
    detectionFps: resolved.detectionFps,
    activityDetectionFps: resolved.activityDetectionFps,
    motionCooldownMs: resolved.motionCooldownMs,
    maxSessionHoldMs: resolved.maxSessionHoldMs,
    audioMotionWindowMs: resolved.audioMotionWindowMs,
    audioStreamPick: resolved.audioStreamPick,
    detectionMode: resolved.detectionMode,
    audioMode: resolved.audioMode,
    onboardMotionDrivesAnalyzer: resolved.onboardMotionDrivesAnalyzer,
    occupancyRecheckEnabled: resolved.occupancyRecheckEnabled,
    occupancyRecheckSec: resolved.occupancyRecheckSec,
    occupancyRecheckFrames: resolved.occupancyRecheckFrames,
    preRollInferenceEnabled: resolved.preRollInferenceEnabled,
    preRollInferenceFrames: resolved.preRollInferenceFrames,
  }
}

// ── detectionConfigEquals ─────────────────────────────────────────────────

/**
 * Field-by-field comparison of two `CameraDetectionConfig` records.
 * `motionSources` is an unordered set; everything else is a primitive.
 */
export function detectionConfigEquals(a: CameraDetectionConfig, b: CameraDetectionConfig): boolean {
  if (a.enabled !== b.enabled) return false
  if (a.pipelineEnabled !== b.pipelineEnabled) return false
  if (a.detectionMode !== b.detectionMode) return false
  if (a.audioMode !== b.audioMode) return false
  if (a.motionStreamId !== b.motionStreamId) return false
  if (a.detectionStreamId !== b.detectionStreamId) return false
  if (a.motionFps !== b.motionFps) return false
  if (a.detectionFps !== b.detectionFps) return false
  if (a.activityDetectionFps !== b.activityDetectionFps) return false
  if (a.motionCooldownMs !== b.motionCooldownMs) return false
  if (a.maxSessionHoldMs !== b.maxSessionHoldMs) return false
  if (a.audioMotionWindowMs !== b.audioMotionWindowMs) return false
  if (a.audioStreamPick !== b.audioStreamPick) return false
  if (a.onboardMotionDrivesAnalyzer !== b.onboardMotionDrivesAnalyzer) return false
  if (a.occupancyRecheckEnabled !== b.occupancyRecheckEnabled) return false
  if (a.occupancyRecheckSec !== b.occupancyRecheckSec) return false
  if (a.occupancyRecheckFrames !== b.occupancyRecheckFrames) return false
  if (a.preRollInferenceEnabled !== b.preRollInferenceEnabled) return false
  if (a.preRollInferenceFrames !== b.preRollInferenceFrames) return false
  if (a.motionSources.length !== b.motionSources.length) return false
  for (const s of a.motionSources) if (!b.motionSources.includes(s)) return false
  return true
}

// ── buildRunnerConfig ─────────────────────────────────────────────────────

/**
 * Base inputs every `RunnerCameraConfig` build site shares — the resolved
 * `CameraDetectionConfig`, the device id (not carried on that config type),
 * and the per-camera zone snapshot fetched at dispatch time.
 */
export interface RunnerConfigBase {
  readonly deviceId: number
  readonly config: CameraDetectionConfig
  readonly zones: readonly Zone[]
}

/**
 * Per-site divergences from the shared base. Every field defaults to the
 * base `config`'s own value (or `[]`/`null` for `steps`/`audio`) when
 * omitted — mirrors `startDetection`'s always-on literal exactly.
 */
export interface RunnerConfigOverrides {
  readonly motionSources?: MotionSources
  readonly detectionSources?: DetectionSources
  readonly pipelineEnabled?: boolean
  readonly steps?: readonly PipelineStepInputOutput[]
  readonly audio?: { readonly modelId?: string; readonly enabled: boolean } | null
  readonly detectionMode?: PipelinePhaseMode
  readonly audioMode?: PipelinePhaseMode
}

/**
 * Single-source-of-truth `RunnerCameraConfig` literal builder (smell #10).
 * The literal used to be hand-built field-by-field at 3 sites
 * (`startDetection`, `ensureMotionWatch`, `dispatchDetectionSession`) that
 * differ only in `motionSources` / `detectionMode` / `audioMode` / `steps` /
 * `audio` — every other field is copied straight off the resolved
 * `CameraDetectionConfig`. This step wires it ONLY into `startDetection`'s
 * always-on branch; the two Phase-3 session-time sites are left as
 * hand-built literals (a later refactor step migrates them).
 */
export function buildRunnerConfig(
  base: RunnerConfigBase,
  overrides?: RunnerConfigOverrides,
): RunnerCameraConfig {
  const { deviceId, config, zones } = base
  return {
    deviceId,
    motionCooldownMs: config.motionCooldownMs,
    motionFps: config.motionFps,
    detectionFps: config.detectionFps,
    motionStreamId: config.motionStreamId,
    detectionStreamId: config.detectionStreamId,
    // Orchestrator-only, but it must travel with the config: the watchdog reads
    // this shape to arm the audio stage and has to resolve the SAME stream the
    // subscription did (D537).
    ...(config.audioStreamPick !== undefined ? { audioStreamPick: config.audioStreamPick } : {}),
    motionSources: overrides?.motionSources ?? config.motionSources,
    // Absent all the way down is `['pipeline']` (`planDetectionSources`): the
    // runner reads an omitted list as today's behaviour, so a config written
    // before the field never silently loses its root step.
    ...(() => {
      const sources = overrides?.detectionSources ?? config.detectionSources
      return sources !== undefined ? { detectionSources: sources } : {}
    })(),
    pipelineEnabled: overrides?.pipelineEnabled ?? config.pipelineEnabled,
    steps: overrides?.steps ?? [],
    audio: overrides?.audio ?? null,
    zones,
    detectionMode: overrides?.detectionMode ?? config.detectionMode,
    audioMode: overrides?.audioMode ?? config.audioMode,
    onboardMotionDrivesAnalyzer: config.onboardMotionDrivesAnalyzer,
    occupancyRecheckEnabled: config.occupancyRecheckEnabled,
    occupancyRecheckSec: config.occupancyRecheckSec,
    occupancyRecheckFrames: config.occupancyRecheckFrames,
    preRollInferenceEnabled: config.preRollInferenceEnabled,
    preRollInferenceFrames: config.preRollInferenceFrames,
  }
}
