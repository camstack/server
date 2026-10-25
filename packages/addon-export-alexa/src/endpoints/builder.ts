/**
 * Build the Alexa Smart Home endpoint payload for a single camstack
 * device. The Discovery handler aggregates these into an
 * `Alexa.Discovery/Discover.Response`.
 *
 * Endpoint topology:
 *   - Each exposed camera produces ONE parent endpoint with
 *     `endpointId = String(deviceId)` carrying the streaming +
 *     directive surfaces (CameraStream, RTCSession, Doorbell when the
 *     camera has a doorbell, ModeController for PTZ presets when the
 *     camera reports them).
 *   - Each child accessory of the camera (siren / floodlight / PIR /
 *     etc.) becomes a SEPARATE endpoint with
 *     `endpointId = ${parentId}__${childId}` carrying PowerController +
 *     BrightnessController (when applicable). The `__` separator lets
 *     directive handlers decode the routing target cheaply.
 *   - PTZ autotrack — when the parent camera exposes the
 *     `ptz-autotrack` cap — becomes a synthetic child endpoint
 *     `${parentId}__autotrack` with PowerController. We don't model it
 *     as a true child device on the camstack side; the autotrack toggle
 *     lives on the camera's own cap, so the Alexa endpoint id encodes
 *     the routing.
 */
import type { AlarmArmMode } from '@camstack/types'

import { type DetectionSensorClass, detectionSensorEndpointId } from '../handlers/endpoint-id.js'
import { supportedArmStatesFor } from '../handlers/security-panel-arm-state.js'
import type {
  AlexaCapability,
  AlexaDisplayCategory,
  AlexaEndpoint,
  AlexaSupportedMode,
} from './types.js'

const DEFAULT_RESOLUTIONS = [
  { width: 1920, height: 1080 },
  { width: 1280, height: 720 },
] as const

const ALEXA_BASE_CAPABILITY: AlexaCapability = {
  type: 'AlexaInterface',
  interface: 'Alexa',
  version: '3',
}

const CAMERA_STREAM_CONTROLLER: AlexaCapability = {
  type: 'AlexaInterface',
  interface: 'Alexa.CameraStreamController',
  version: '3',
  cameraStreamConfigurations: [
    {
      protocols: ['RTSP'],
      resolutions: DEFAULT_RESOLUTIONS,
      authorizationTypes: ['BASIC'],
      videoCodecs: ['H264'],
      audioCodecs: ['AAC'],
    },
  ],
}

/**
 * `Alexa.EndpointHealth` v3.1 — `connectivity`, retrievable and proactive.
 *
 * Required by Amazon on every sensor endpoint (a camera with MotionSensor is
 * one) and for live view it is load-bearing: the first time it was declared,
 * the hub only ever reported a TRANSITION and ReportState never answered it,
 * so Alexa held no value — and the phone app refused live view on an endpoint
 * of unknown health while an Echo Show kept streaming. It is declared ONLY
 * together with what keeps a value in Alexa's hands (D770):
 *
 *   - `handlers/report-state.ts` answers `connectivity` for every endpoint
 *     that declares it (`OK` when the status read itself fails);
 *   - `LwaEventGateway.scheduleInitialConnectivity` reports it after every
 *     AddOrUpdateReport and every Discover;
 *   - the gateway's online/offline ChangeReports keep it current.
 *
 * `endpoint-health.spec.ts` pins all three.
 */
export const ENDPOINT_HEALTH: AlexaCapability = {
  type: 'AlexaInterface',
  interface: 'Alexa.EndpointHealth',
  version: '3.1',
  properties: {
    supported: [{ name: 'connectivity' }],
    proactivelyReported: true,
    retrievable: true,
  },
}

const DOORBELL_EVENT_SOURCE: AlexaCapability = {
  type: 'AlexaInterface',
  interface: 'Alexa.DoorbellEventSource',
  version: '3',
  proactivelyReported: true,
}

const MOTION_SENSOR: AlexaCapability = {
  type: 'AlexaInterface',
  interface: 'Alexa.MotionSensor',
  version: '3',
  properties: {
    supported: [{ name: 'detectionState' }],
    // Proactively reported via the Event Gateway (ChangeReport) when the
    // camera's `motion` cap flips detection state; also retrievable.
    proactivelyReported: true,
    retrievable: true,
  },
}

/** The only classes `Alexa.SmartVision.ObjectDetectionSensor` knows (Amazon:
 *  `imageNetClass` is `person` or `package`; anything else is dropped). */
export const SMART_VISION_CLASSES = ['person', 'package'] as const
export type SmartVisionClass = (typeof SMART_VISION_CLASSES)[number]

/** `Alexa.DataController` instance that serves the camera's detection history. */
export const SMART_VISION_DATA_INSTANCE = 'Camera.SmartVisionData'

/**
 * `Alexa.SmartVision.ObjectDetectionSensor` v1.0 on the CAMERA endpoint (R4,
 * D779) — the per-camera event history and the "person detected"
 * announcements in the Alexa app. Amazon lists it for en-US only; it is built
 * here as an experiment to find out what an it-IT account does with it.
 *
 * The shape is Amazon's discovery example to the letter, minus the empty
 * `properties: {}` (the interface defines no reportable property; omission is
 * how this file expresses that — see `DOORBELL_EVENT_SOURCE`). No
 * `isAvailable` / `unavailabilityReason`: both are optional and only describe a
 * subscription-gated class. An earlier declaration that ALSO claimed a
 * retrievable `objectDetectionClasses` property (never answered by ReportState)
 * made Alexa reject the camera and every child — so: no properties at all.
 *
 * `classes` is `person`, plus `package` only on a camera whose pipeline can
 * produce package events (the same answer the detection sensors use).
 */
export function smartVisionObjectDetectionSensor(
  classes: readonly SmartVisionClass[],
): AlexaCapability {
  return {
    type: 'AlexaInterface',
    interface: 'Alexa.SmartVision.ObjectDetectionSensor',
    version: '1.0',
    configuration: {
      objectDetectionConfiguration: classes.map((imageNetClass) => ({ imageNetClass })),
    },
  }
}

/**
 * `Alexa.DataController` v1.0, instance {@link SMART_VISION_DATA_INSTANCE} —
 * how the Alexa app reads the camera's detection history back
 * (`ReportData` / `DeleteData`, `handlers/data-controller.ts`). Amazon's
 * ObjectDetectionSensor example declares it beside the sensor; the instance
 * name is the one that example uses.
 */
export const SMART_VISION_DATA_CONTROLLER: AlexaCapability = {
  type: 'AlexaInterface',
  interface: 'Alexa.DataController',
  instance: SMART_VISION_DATA_INSTANCE,
  version: '1.0',
  configuration: {
    targetCapability: { name: 'Alexa.SmartVision.ObjectDetectionSensor', version: '1.0' },
    dataRetrievalSchema: { type: 'JSON', schema: 'SmartVisionData' },
    supportedAccess: ['BY_IDENTIFIER', 'BY_TIMESTAMP_RANGE'],
  },
}

/**
 * `Alexa.SmartVision.SnapshotProvider` v1.1 — the camera's still in the Alexa
 * app (R2, D773). Available in it-IT and en-GB, unlike object detection.
 * Declared on every camera while the integration's "Snapshots" switch is on;
 * `GetSnapshot` answers with a signed, ten-minute, account-token-checked image
 * on the hub's public address (`handlers/snapshot-provider.ts`).
 *
 * `minRefreshIntervalInSeconds` bounds how often Alexa may ask per camera:
 * every ask is a snapshot read and a re-encode on the hub, and a picture of the
 * home handed to Amazon, so the tile refreshes at most every few minutes.
 */
export const SMART_VISION_SNAPSHOT_PROVIDER: AlexaCapability = {
  type: 'AlexaInterface',
  interface: 'Alexa.SmartVision.SnapshotProvider',
  version: '1.1',
  configuration: {
    isAvailable: true,
    minRefreshIntervalInSeconds: 180,
  },
}

function rtcSessionController(fullDuplexAudio: boolean): AlexaCapability {
  return {
    type: 'AlexaInterface',
    interface: 'Alexa.RTCSessionController',
    version: '3',
    configuration: {
      isFullDuplexAudioSupported: fullDuplexAudio,
    },
  }
}

/** Proactively reported (R3, D776): `StateChangeReporter` pushes every
 *  `switch` / `privacy-mask` / `ptz-autotrack` / `brightness` change. */
const POWER_CONTROLLER: AlexaCapability = {
  type: 'AlexaInterface',
  interface: 'Alexa.PowerController',
  version: '3',
  properties: {
    supported: [{ name: 'powerState' }],
    proactivelyReported: true,
    retrievable: true,
  },
}

const BRIGHTNESS_CONTROLLER: AlexaCapability = {
  type: 'AlexaInterface',
  interface: 'Alexa.BrightnessController',
  version: '3',
  properties: {
    supported: [{ name: 'brightness' }],
    proactivelyReported: true,
    retrievable: true,
  },
}

/**
 * PTZ directional toggle — one `Alexa.ToggleController` instance per
 * pan/tilt direction. Each is MOMENTARY: turning the toggle ON moves the
 * head ~1 s through the driver's own self-terminating `ptz.move` pulses
 * (`round(TARGET_TRAVEL_MS / getOptions().moveImpulseMs)` of them, one
 * when the impulse is unknown — see `handlers/ptz-travel.ts`; never
 * `continuousMove` / `stop`), and the toggle auto-resets to OFF (handler
 * returns the OFF state in `context.properties`). Alexa renders one row per instance in the
 * device detail; users can also say "Alexa, turn on Hall Pan Left".
 *
 * Instance ids match the directive routing in `ptz-direction.ts`.
 */
function ptzDirectionToggle(
  instance: 'panLeft' | 'panRight' | 'tiltUp' | 'tiltDown',
  friendlyText: string,
): AlexaCapability {
  return {
    type: 'AlexaInterface',
    interface: 'Alexa.ToggleController',
    version: '3',
    instance: `ptz.${instance}`,
    capabilityResources: {
      friendlyNames: [{ '@type': 'text', value: { text: friendlyText, locale: 'en-US' } }],
    },
    properties: {
      supported: [{ name: 'toggleState' }],
      // Momentary: we never proactively report OFF — Alexa is told via
      // the directive response that the new state is OFF. Retrievable
      // false because the underlying ptz cap has no idle-state read.
      proactivelyReported: false,
      retrievable: false,
      nonControllable: false,
    },
  }
}

const PTZ_DIRECTION_TOGGLES: readonly AlexaCapability[] = [
  ptzDirectionToggle('panLeft', 'Pan Left'),
  ptzDirectionToggle('panRight', 'Pan Right'),
  ptzDirectionToggle('tiltUp', 'Tilt Up'),
  ptzDirectionToggle('tiltDown', 'Tilt Down'),
]

/**
 * Directional PTZ ModeControllers. The Alexa app collapses ToggleController
 * instances on camera endpoints into the Routines builder and does NOT
 * render them on the device tile — voice commands work but tap-to-drive
 * doesn't. Wrapping pan + tilt as ModeController dropdowns puts them
 * back on the visible device card. Each `set` is momentary: the value
 * resets to `center` server-side after the pulse and the next dropdown
 * change drives another move.
 */
function ptzDirectionalModeController(
  instance: 'ptz.pan' | 'ptz.tilt',
  friendlyText: string,
  modes: ReadonlyArray<{ value: string; label: string }>,
): AlexaCapability {
  return {
    type: 'AlexaInterface',
    interface: 'Alexa.ModeController',
    version: '3',
    instance,
    capabilityResources: {
      friendlyNames: [{ '@type': 'text', value: { text: friendlyText, locale: 'en-US' } }],
    },
    properties: {
      supported: [{ name: 'mode' }],
      // Mode is momentary — the cap stops on a timer server-side; not
      // retrievable, not proactively reported. `retrievable: false`
      // prevents the periodic Alexa poll from chasing a meaningless
      // "current direction" value.
      proactivelyReported: false,
      retrievable: false,
      nonControllable: false,
    },
    configuration: {
      ordered: false,
      supportedModes: modes.map(({ value, label }) => ({
        value,
        modeResources: {
          friendlyNames: [{ '@type': 'text', value: { text: label, locale: 'en-US' } }],
        },
      })),
    },
  }
}

const PTZ_PAN_MODE_CONTROLLER = ptzDirectionalModeController('ptz.pan', 'Pan', [
  { value: 'ptz.pan.left', label: 'Left' },
  { value: 'ptz.pan.center', label: 'Center' },
  { value: 'ptz.pan.right', label: 'Right' },
])

const PTZ_TILT_MODE_CONTROLLER = ptzDirectionalModeController('ptz.tilt', 'Tilt', [
  { value: 'ptz.tilt.up', label: 'Up' },
  { value: 'ptz.tilt.center', label: 'Center' },
  { value: 'ptz.tilt.down', label: 'Down' },
])

/** Amazon (alexa-modecontroller): "You must include a minimum of two mode
 *  objects." One preset made the camera's whole AddOrUpdateReport fail
 *  schema validation, and Discover dropped the camera. */
const MIN_MODE_CONTROLLER_MODES = 2

/**
 * Preset names as distinct mode values. Two presets with the same name (the
 * camera allows it: `Stanza`, `Stanza`; `CamStack Home` ×3) produced two
 * identical modes, and Alexa rejected the capability — "Invalid capability
 * received." — and with it every endpoint of the camera. First wins,
 * case-insensitively: the SetMode handler resolves a value to the first
 * preset of that name, which is the one kept.
 */
function distinctPresetNames(names: readonly string[]): readonly string[] {
  const seen = new Set<string>()
  return names.filter((name) => {
    const key = name.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function ptzPresetModeController(presetNames: readonly string[]): AlexaCapability {
  const supportedModes: AlexaSupportedMode[] = presetNames.map((name) => ({
    value: `ptz.preset.${name}`,
    modeResources: {
      friendlyNames: [
        {
          '@type': 'text',
          value: { text: name, locale: 'en-US' },
        },
      ],
    },
  }))
  return {
    type: 'AlexaInterface',
    interface: 'Alexa.ModeController',
    version: '3',
    instance: 'ptz.preset',
    capabilityResources: {
      friendlyNames: [
        {
          '@type': 'text',
          value: { text: 'Preset', locale: 'en-US' },
        },
      ],
    },
    properties: {
      supported: [{ name: 'mode' }],
      proactivelyReported: false,
      retrievable: false,
      nonControllable: false,
    },
    configuration: {
      ordered: false,
      supportedModes,
    },
  }
}

// ── Parent (camera) endpoint ────────────────────────────────────────

export interface BuildParentEndpointInput {
  readonly deviceId: number
  readonly stableId: string
  readonly friendlyName: string
  /** True when the camera has a child with doorbell role OR the
   *  camera's own `doorbell` cap is bound. */
  readonly isDoorbell: boolean
  /** True when the camera has `intercom` cap → enable full-duplex
   *  audio on the RTCSessionController. */
  readonly hasIntercom: boolean
  /** True when the camera has the `motion` cap → emit MotionSensor
   *  (proactive ChangeReports flow via the Event Gateway). */
  readonly hasMotion: boolean
  /** Non-empty list of PTZ preset names → emit ModeController. */
  readonly ptzPresetNames: readonly string[]
  /** The integration's "Snapshots" switch is on → declare SnapshotProvider. */
  readonly snapshotProvider?: boolean
  /** R4 (D779): non-empty → declare ObjectDetectionSensor (these classes) and
   *  the DataController that serves its history. */
  readonly objectDetectionClasses?: readonly SmartVisionClass[]
  /** True when the camera has the `ptz` cap → emit four directional
   *  `Alexa.ToggleController` instances (Pan L/R, Tilt U/D) so users
   *  can drive continuous-move via Alexa without configuring presets. */
  readonly hasPtz: boolean
}

export function buildParentCameraEndpoint(input: BuildParentEndpointInput): AlexaEndpoint {
  const displayCategories: readonly AlexaDisplayCategory[] = input.isDoorbell
    ? ['CAMERA', 'DOORBELL']
    : ['CAMERA']

  const capabilities: AlexaCapability[] = [
    ALEXA_BASE_CAPABILITY,
    CAMERA_STREAM_CONTROLLER,
    rtcSessionController(input.hasIntercom),
    ENDPOINT_HEALTH,
  ]
  if (input.isDoorbell) capabilities.push(DOORBELL_EVENT_SOURCE)
  if (input.hasMotion) capabilities.push(MOTION_SENSOR)
  // R4 (D779): object detection + its history. Fed by the pipeline's tracks
  // (`vision/object-detection-feed.ts`), never by firmware motion.
  const visionClasses = input.objectDetectionClasses ?? []
  if (visionClasses.length > 0) {
    capabilities.push(smartVisionObjectDetectionSensor(visionClasses))
    capabilities.push(SMART_VISION_DATA_CONTROLLER)
  }
  if (input.snapshotProvider === true) capabilities.push(SMART_VISION_SNAPSHOT_PROVIDER)
  // No battery interface: `Alexa.BatteryLevelSensor` is not in Amazon's
  // interface list and no documented interface carries a battery level
  // (InventoryLevelSensor is for consumables; EndpointHealth documents only
  // `connectivity`). Battery stays visible in CamStack. See D769.
  const presetNames = distinctPresetNames(input.ptzPresetNames)
  if (presetNames.length >= MIN_MODE_CONTROLLER_MODES) {
    capabilities.push(ptzPresetModeController(presetNames))
  }
  if (input.hasPtz) {
    // ModeController dropdowns render on the Alexa device card.
    capabilities.push(PTZ_PAN_MODE_CONTROLLER)
    capabilities.push(PTZ_TILT_MODE_CONTROLLER)
    // ToggleControllers stay for voice ("Alexa, turn on Hall Pan Left")
    // — the Alexa app hides them from the tile but Routines + voice
    // commands resolve them, so they're worth keeping.
    capabilities.push(...PTZ_DIRECTION_TOGGLES)
  }

  return {
    endpointId: String(input.deviceId),
    manufacturerName: 'camstack',
    description: 'CamStack camera',
    friendlyName: input.friendlyName.length > 0 ? input.friendlyName : `Camera ${input.deviceId}`,
    displayCategories,
    capabilities,
    cookie: { stableId: input.stableId },
  }
}

// ── Child accessory endpoint ────────────────────────────────────────

export type ChildAccessoryKind = 'light' | 'switch' | 'siren'

export interface BuildChildEndpointInput {
  readonly parentDeviceId: number
  readonly parentName: string
  readonly childDeviceId: number
  readonly childStableId: string
  readonly childName: string
  readonly kind: ChildAccessoryKind
  /** True when the child also has the `brightness` cap. */
  readonly hasBrightness: boolean
}

/**
 * Compose a child accessory's Alexa friendly name. camstack child devices
 * are usually already named with their parent prefix (e.g. parent
 * "Camera hall" → child "Camera hall Siren"), so blindly
 * prefixing the parent again yields "Camera hall — Camera hall
 * Siren". Skip the prefix when the child name already contains the parent name
 * (case-insensitive).
 */
function composeChildFriendlyName(
  parentName: string,
  childName: string,
  childDeviceId: number,
): string {
  const parent = parentName.trim()
  const child = childName.trim()
  if (child.length === 0) {
    return parent.length > 0
      ? `${parent} — accessory ${childDeviceId}`
      : `Accessory ${childDeviceId}`
  }
  if (parent.length === 0 || child.toLowerCase().includes(parent.toLowerCase())) {
    return child
  }
  return `${parent} — ${child}`
}

export function buildChildAccessoryEndpoint(input: BuildChildEndpointInput): AlexaEndpoint {
  const displayCategories: readonly AlexaDisplayCategory[] =
    input.kind === 'light' ? ['LIGHT'] : ['SWITCH']
  const capabilities: AlexaCapability[] = [ALEXA_BASE_CAPABILITY, POWER_CONTROLLER]
  if (input.hasBrightness) capabilities.push(BRIGHTNESS_CONTROLLER)

  const friendlyName = composeChildFriendlyName(
    input.parentName,
    input.childName,
    input.childDeviceId,
  )

  return {
    endpointId: `${input.parentDeviceId}__${input.childDeviceId}`,
    manufacturerName: 'camstack',
    description: `CamStack ${input.kind}`,
    friendlyName,
    displayCategories,
    capabilities,
    cookie: {
      stableId: input.childStableId,
      parentDeviceId: String(input.parentDeviceId),
      childDeviceId: String(input.childDeviceId),
    },
  }
}

// ── Autotrack pseudo-child endpoint ─────────────────────────────────

export interface BuildAutotrackEndpointInput {
  readonly parentDeviceId: number
  readonly parentStableId: string
  readonly parentName: string
}

export function buildAutotrackEndpoint(input: BuildAutotrackEndpointInput): AlexaEndpoint {
  return {
    endpointId: `${input.parentDeviceId}__autotrack`,
    manufacturerName: 'camstack',
    description: 'CamStack autotrack toggle',
    friendlyName:
      input.parentName.length > 0
        ? `${input.parentName} — Autotrack`
        : `Autotrack ${input.parentDeviceId}`,
    displayCategories: ['SWITCH'],
    capabilities: [ALEXA_BASE_CAPABILITY, POWER_CONTROLLER],
    cookie: {
      stableId: input.parentStableId,
      parentDeviceId: String(input.parentDeviceId),
      kind: 'autotrack',
    },
  }
}

// ── Privacy pseudo-child endpoint ───────────────────────────────────

export interface BuildPrivacyEndpointInput {
  readonly parentDeviceId: number
  readonly parentStableId: string
  readonly parentName: string
}

/**
 * Privacy-mask toggle as a pseudo-child endpoint mirroring the
 * autotrack pattern. On/Off maps to `privacyMask.setMask({ patch: {
 * enabled } })` — when on, the camera-side provider applies the
 * privacy mask, halting the streaming + recording pipeline behind
 * the masked regions (or globally for a full-frame mask).
 *
 * The pseudo-child endpoint id `${parent}__privacy` lets the directive
 * router decode the routing target without enumerating the privacy
 * cap on every parsed endpoint.
 */
export function buildPrivacyEndpoint(input: BuildPrivacyEndpointInput): AlexaEndpoint {
  return {
    endpointId: `${input.parentDeviceId}__privacy`,
    manufacturerName: 'camstack',
    description: 'CamStack privacy mask toggle',
    friendlyName:
      input.parentName.length > 0
        ? `${input.parentName} — Privacy`
        : `Privacy ${input.parentDeviceId}`,
    displayCategories: ['SWITCH'],
    capabilities: [ALEXA_BASE_CAPABILITY, POWER_CONTROLLER],
    cookie: {
      stableId: input.parentStableId,
      parentDeviceId: String(input.parentDeviceId),
      kind: 'privacy',
    },
  }
}

// ── Alarm panel endpoint ────────────────────────────────────────────

export interface BuildAlarmPanelEndpointInput {
  readonly deviceId: number
  readonly stableId: string
  readonly friendlyName: string
  /** The arm modes the panel accepts. EMPTY means unknown, not none — see
   *  `supportedArmStatesFor`. */
  readonly availableModes: readonly AlarmArmMode[]
  /** Whether the panel demands a PIN. Decides whether a `FOUR_DIGIT_PIN`
   *  authorization type is declared, which is what makes the Alexa app prompt
   *  for one on Disarm. */
  readonly requiresCode: boolean
}

/**
 * An `alarm-panel` device as an `Alexa.SecurityPanelController` endpoint.
 *
 * It is its OWN endpoint, not a child of a camera: a panel is a standalone
 * device and has no stream, no doorbell and no PTZ. The `__alarm` suffix on
 * the endpoint id is a routing tag (see `handlers/endpoint-id.ts`).
 *
 * ## What is declared, and what is deliberately not
 *
 *  - `armState` and `burglaryAlarm` are the two properties this cap can fill
 *    honestly. `fireAlarm` / `carbonMonoxideAlarm` / `waterAlarm` are NOT
 *    declared: `alarm-panel` has no field saying WHICH alarm is sounding, and
 *    declaring a property we would always answer `OK` on is a claim with no
 *    basis behind it. The reasoning is in `security-panel-arm-state.ts`.
 *  - `proactivelyReported: true` (R3, D776). Amazon asks for alarms to be
 *    reported proactively; `StateChangeReporter` pushes every `alarm-panel`
 *    slice change (arm state and the burglary alarm). `retrievable: true` —
 *    `Alexa/ReportState` answers too.
 *  - `supportedAuthorizationTypes` appears only for a panel that requires a
 *    code. Alexa's Disarm directive can carry a PIN; its **Arm directive
 *    cannot**, which is why a PIN-gated arm is refused by the handler with
 *    `AUTHORIZATION_REQUIRED` rather than attempted.
 */
export function buildAlarmPanelEndpoint(input: BuildAlarmPanelEndpointInput): AlexaEndpoint {
  const configuration: Record<string, unknown> = {
    supportedArmStates: supportedArmStatesFor(input.availableModes).map((value) => ({ value })),
  }
  if (input.requiresCode) {
    configuration.supportedAuthorizationTypes = [{ type: 'FOUR_DIGIT_PIN' }]
  }

  const securityPanelController: AlexaCapability = {
    type: 'AlexaInterface',
    interface: 'Alexa.SecurityPanelController',
    version: '3',
    properties: {
      supported: [{ name: 'armState' }, { name: 'burglaryAlarm' }],
      proactivelyReported: true,
      retrievable: true,
    },
    configuration,
  }

  return {
    endpointId: `${input.deviceId}__alarm`,
    manufacturerName: 'camstack',
    description: 'CamStack alarm panel',
    friendlyName:
      input.friendlyName.trim().length > 0 ? input.friendlyName.trim() : `Alarm ${input.deviceId}`,
    displayCategories: ['SECURITY_PANEL'],
    capabilities: [ALEXA_BASE_CAPABILITY, securityPanelController],
    cookie: { stableId: input.stableId },
  }
}

// ── Detection sensor endpoint (R1) ──────────────────────────────────

/** How a detection sensor is named after its camera. English, like every
 *  other name this skill publishes; the operator can rename it in the app. */
const DETECTION_SENSOR_LABELS: Readonly<Record<DetectionSensorClass, string>> = {
  person: 'Person',
  vehicle: 'Vehicle',
  animal: 'Animal',
  package: 'Package',
}

export interface BuildDetectionSensorInput {
  readonly deviceId: number
  readonly stableId: string
  readonly cameraName: string
  readonly detectionClass: DetectionSensorClass
}

/**
 * One class of a camera's detections as an `Alexa.MotionSensor` endpoint —
 * "Front door Person" (R1, D772). It is what an it-IT / en-GB account can use
 * as a routine trigger ("when Front door Person detects motion → announce…"):
 * Amazon's object-detection interface is en-US only, MotionSensor is not.
 * Driven by the pipeline's tracks, not by the camera's own motion. Sensors
 * need `Alexa.EndpointHealth` (Amazon), reported like the camera's (D770).
 */
export function buildDetectionSensorEndpoint(input: BuildDetectionSensorInput): AlexaEndpoint {
  const label = DETECTION_SENSOR_LABELS[input.detectionClass]
  const camera =
    input.cameraName.trim().length > 0 ? input.cameraName.trim() : `Camera ${input.deviceId}`
  return {
    endpointId: detectionSensorEndpointId(input.deviceId, input.detectionClass),
    manufacturerName: 'camstack',
    description: `CamStack ${input.detectionClass} detection`,
    friendlyName: `${camera} ${label}`,
    displayCategories: ['MOTION_SENSOR'],
    capabilities: [ALEXA_BASE_CAPABILITY, MOTION_SENSOR, ENDPOINT_HEALTH],
    cookie: { stableId: input.stableId, detectionClass: input.detectionClass },
  }
}
