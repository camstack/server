/**
 * `Alexa.Discovery/Discover` handler — fires when the Alexa app pulls
 * the user's device list. We respond with the operator-curated
 * `exposed-devices.json` list, resolved against the live device
 * registry (so we don't return zombie endpoints for deleted devices).
 *
 * Feature detection is PASSIVE: per exposed device we inspect the
 * `DeviceInfo.features` + bound caps (from `device-manager.getBindings`)
 * and emit only the Alexa capabilities backed by something on our side.
 * Child accessories (siren/floodlight/PIR/…) become SEPARATE endpoints
 * with `endpointId = ${parent}__${child}` so directive handlers can
 * route to the right cap on the right device.
 */

import type { AddonApi, AddonContext, IScopedLogger } from '@camstack/types'
import { AlarmPanelStatusSchema } from '@camstack/types'
import type { VerifiedDirectiveIdentity } from '../directive-router.js'
import {
  buildAlarmPanelEndpoint,
  buildAutotrackEndpoint,
  buildDetectionSensorEndpoint,
  buildChildAccessoryEndpoint,
  buildParentCameraEndpoint,
  buildPrivacyEndpoint,
  type ChildAccessoryKind,
  type SmartVisionClass,
} from '../endpoints/builder.js'
import { discoveryReadCaps } from '../endpoints/adapters/index.js'
import { GENERIC_DEVICE_TYPES, planGenericEndpoint } from '../endpoints/generic-device.js'
import type { AlexaEndpoint } from '../endpoints/types.js'
import type { ExposedDeviceEntry } from '../types.js'
import type { DetectionSensorClass } from './endpoint-id.js'
import { errorEnvelope } from './error-envelope.js'
import { isAlexaRecallablePreset } from './ptz-preset-recallable.js'
import { type DirectiveHeader, DiscoveryDirectiveSchema } from './types.js'

const discoveryPayloadSchema = DiscoveryDirectiveSchema.shape.payload

/** Devices built at once in `handleDiscovery` — latency-bound tRPC reads, so
 *  six lanes hide the round-trips without stampeding a booting hub. */
const DISCOVERY_BUILD_CONCURRENCY = 6

// ── Cap-name constants ──────────────────────────────────────────────
//
// Discovery does cap detection by name (binding entries carry
// `capName: string`). Centralised here so a rename in `*.cap.ts`
// produces a single grep target.
const CAP_DOORBELL = 'doorbell'
const CAP_INTERCOM = 'intercom'
// `motion` (the native firmware sensor, whose provider emits
// `MotionOnMotionChanged`) — NOT `motion-detection` (the local ML pipeline).
// The gateway's proactive ChangeReports ride the former, so this is the cap
// whose presence must gate the `Alexa.MotionSensor` declaration.
const CAP_MOTION = 'motion'
const CAP_PTZ = 'ptz'
const CAP_PTZ_AUTOTRACK = 'ptz-autotrack'
const CAP_SWITCH = 'switch'
const CAP_BRIGHTNESS = 'brightness'
const CAP_PRIVACY_MASK = 'privacy-mask'
const CAP_ALARM_PANEL = 'alarm-panel'

/** What building one device's endpoints needs. */
export interface DeviceBuildContext {
  readonly ctx: AddonContext
  readonly logger: IScopedLogger
  /**
   * The detection classes a camera publishes a sensor for (R1, D772). Absent
   * when the integration's "Detection sensors" switch is off — then no camera
   * gets any.
   */
  readonly detectionClasses?: (deviceId: number) => Promise<readonly DetectionSensorClass[]>
  /** The integration's "Snapshots" switch (R2, D773): every camera declares
   *  `Alexa.SmartVision.SnapshotProvider` while it is on. */
  readonly snapshots?: boolean
  /**
   * R4 (D779): the object-detection classes a camera declares
   * (`Alexa.SmartVision.ObjectDetectionSensor` + `Alexa.DataController`).
   * Absent when the integration switch is off; an empty answer (the camera's
   * own toggle off) declares neither.
   */
  readonly objectDetection?: (deviceId: number) => Promise<readonly SmartVisionClass[]>
  /**
   * D875: the operator's Alexa name for a device (its `friendlyName`), or null
   * for the device's own name. A failed read answers null: a name that cannot
   * be read must not rename the device in Alexa (D49).
   */
  readonly alexaName?: (deviceId: number) => Promise<string | null>
}

export interface DiscoveryContext extends DeviceBuildContext {
  readonly listExposed: () => Promise<readonly ExposedDeviceEntry[]>
  /** Build ONE exposed device's endpoints — the same builder the push path
   *  uses (`buildEndpointsForExposedDevice` in production). */
  readonly buildEndpoints: (deviceId: number) => Promise<readonly AlexaEndpoint[]>
}

/**
 * Which of the built endpoints the caller may be shown (S1, D767). The router
 * supplies it bound to the linking user; discovery never decides access itself.
 */
export interface DiscoveryVisibility {
  /** Cheap pre-filter: may the caller see this exposed device at all? Saves
   *  building a device whose every endpoint would be dropped. */
  readonly deviceVisible: (deviceId: number) => Promise<boolean>
  readonly filterEndpoints: (
    endpoints: readonly AlexaEndpoint[],
  ) => Promise<readonly AlexaEndpoint[]>
}

export async function handleDiscovery(
  header: DirectiveHeader,
  payloadRaw: unknown,
  deps: DiscoveryContext,
  callerIdentity: VerifiedDirectiveIdentity,
  visibility: DiscoveryVisibility,
): Promise<unknown> {
  const parsed = discoveryPayloadSchema.safeParse(payloadRaw)
  if (!parsed.success) {
    return errorEnvelope(header, 'INVALID_DIRECTIVE', 'Discovery payload shape unexpected')
  }

  // Token is already verified by the centralized entry check in
  // handleDirective (http-server.ts). Use the threaded identity.

  const allExposed = await deps.listExposed()
  const exposed: ExposedDeviceEntry[] = []
  for (const entry of allExposed) {
    if (await visibility.deviceVisible(entry.deviceId)) exposed.push(entry)
  }
  // Bounded-parallel with order preserved by index: each device build is 3–5
  // sequential cross-process tRPC calls (getDevice → getBindings →
  // getChildren → per-child getBindings), so a serial loop made the response
  // scale linearly in fleet size — minutes for a 21-camera install at boot.
  const built: (readonly AlexaEndpoint[] | null)[] = new Array(exposed.length).fill(null)
  const queue = exposed.map((entry, index) => ({ entry, index }))
  const lane = async (): Promise<void> => {
    for (;;) {
      const item = queue.shift()
      if (item === undefined) return
      try {
        built[item.index] = await deps.buildEndpoints(item.entry.deviceId)
      } catch (err: unknown) {
        deps.logger.warn('alexa discovery (on-demand): skipping device — build failed', {
          tags: { deviceId: item.entry.deviceId },
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      }
    }
  }
  const lanes = Math.min(DISCOVERY_BUILD_CONCURRENCY, Math.max(1, queue.length))
  await Promise.all(Array.from({ length: lanes }, lane))
  const endpoints = await visibility.filterEndpoints(built.flatMap((b) => b ?? []))

  deps.logger.info('alexa discovery returned endpoints', {
    meta: {
      count: endpoints.length,
      userId: callerIdentity.userId,
      exposedDevices: allExposed.length,
      visibleDevices: exposed.length,
    },
  })

  return discoveryResponse(header, endpoints)
}

// ── Per-device endpoint builder ─────────────────────────────────────

interface BindingEntry {
  readonly capName: string
}

interface BoundDeviceInfo {
  readonly id: number
  readonly stableId: string
  readonly name: string
  readonly features: readonly string[]
  readonly role: string | null
  readonly capNames: readonly string[]
}

export async function buildEndpointsForExposedDevice(
  deviceId: number,
  deps: DeviceBuildContext,
): Promise<AlexaEndpoint[]> {
  const api: AddonApi = deps.ctx.api
  const device = await api.deviceManager.getDevice.query({ deviceId })
  if (!device) {
    deps.logger.warn('alexa discovery: skipping exposed device — not in live registry', {
      tags: { deviceId },
    })
    return []
  }

  const parentInfo = await loadBoundDeviceInfo(device, api)

  // A non-camera device (R5, D775): one generic endpoint from its caps, shaped
  // by the adapter registry (D869).
  if (
    GENERIC_DEVICE_TYPES.includes(String(device.type)) &&
    !parentInfo.capNames.includes(CAP_ALARM_PANEL)
  ) {
    const plan = planGenericEndpoint({
      deviceId: parentInfo.id,
      stableId: parentInfo.stableId,
      name: parentInfo.name,
      alexaName: deps.alexaName === undefined ? null : await deps.alexaName(parentInfo.id),
      type: String(device.type),
      capNames: parentInfo.capNames,
      role: parentInfo.role,
      features: parentInfo.features,
      slices: await readDiscoverySlices(api, parentInfo, deps.logger),
    })
    if (plan.kind === 'endpoint') return [plan.endpoint]
    if (plan.kind === 'skip') {
      logSkippedOnce(deps.logger, deviceId, plan.reasons)
      return []
    }
    deps.logger.warn(
      'alexa discovery: device has no cap Alexa has an interface for - not published',
      {
        tags: { deviceId },
        meta: { type: device.type, capNames: parentInfo.capNames },
      },
    )
    return []
  }

  // An alarm panel is its own endpoint and nothing else: no stream, no
  // doorbell, no children to walk. The branch is taken on the BOUND CAP, not
  // on the device type — the same doctrine the rest of this file follows, and
  // the reason a panel behind an unexpected type still exports.
  if (parentInfo.capNames.includes(CAP_ALARM_PANEL)) {
    return [await buildAlarmPanelEndpointFor(parentInfo, api, deps)]
  }

  const children = await api.deviceManager.getChildren
    .query({ parentDeviceId: deviceId })
    .catch((err: unknown) => {
      deps.logger.warn('alexa discovery: getChildren failed', {
        tags: { deviceId },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return [] as Array<{
        id: number
        stableId: string
        name: string
        role: string | null | undefined
        type: string
        features: readonly string[]
      }>
    })

  // Doorbell is exposed either as a child with role 'doorbell' OR as a
  // feature on the camera itself (older drivers). Either marker flips
  // the Alexa endpoint into DOORBELL display category.
  const hasDoorbellChild = children.some((c) => (c.role ?? null) === 'doorbell')
  const hasDoorbellFeature = parentInfo.features.includes('doorbell-button')
  const isDoorbell =
    hasDoorbellChild || hasDoorbellFeature || parentInfo.capNames.includes(CAP_DOORBELL)

  const hasIntercom = parentInfo.capNames.includes(CAP_INTERCOM)
  const hasMotion = parentInfo.capNames.includes(CAP_MOTION)
  const hasAutotrack = parentInfo.capNames.includes(CAP_PTZ_AUTOTRACK)
  const hasPtz = parentInfo.capNames.includes(CAP_PTZ)
  const hasPrivacy = parentInfo.capNames.includes(CAP_PRIVACY_MASK)

  // Surface the resolved feature flags so the operator can verify
  // exactly which Alexa interfaces will land on a given camera after a
  // re-sync. Without this, missing-cap diagnoses required reading the
  // cap-binding tab AND mentally cross-referencing the discovery code.
  deps.logger.info('alexa discovery: built feature flags', {
    tags: { deviceId: parentInfo.id },
    meta: {
      name: parentInfo.name,
      capNames: parentInfo.capNames,
      hasMotion,
      hasPtz,
      hasAutotrack,
      hasPrivacy,
      hasIntercom,
      isDoorbell,
    },
  })

  // Pull preset list — only call if the cap is bound; the proxy throws
  // when the cap isn't registered.
  let ptzPresetNames: readonly string[] = []
  if (hasPtz) {
    ptzPresetNames = await fetchPtzPresetNames(deviceId, api).catch((err: unknown) => {
      deps.logger.warn('alexa discovery: ptz.getPresets failed', {
        tags: { deviceId },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return []
    })
  }

  const objectDetectionClasses =
    deps.objectDetection === undefined ? [] : await deps.objectDetection(parentInfo.id)

  const alexaName = deps.alexaName === undefined ? null : await deps.alexaName(parentInfo.id)
  const cameraName = alexaName ?? parentInfo.name

  const out: AlexaEndpoint[] = []
  out.push(
    buildParentCameraEndpoint({
      deviceId: parentInfo.id,
      stableId: parentInfo.stableId,
      friendlyName: cameraName,
      isDoorbell,
      hasIntercom,
      hasMotion,
      ptzPresetNames,
      hasPtz,
      snapshotProvider: deps.snapshots === true,
      objectDetectionClasses,
    }),
  )

  if (deps.detectionClasses !== undefined) {
    const classes = await deps.detectionClasses(parentInfo.id)
    for (const detectionClass of classes) {
      out.push(
        buildDetectionSensorEndpoint({
          deviceId: parentInfo.id,
          stableId: parentInfo.stableId,
          cameraName,
          detectionClass,
        }),
      )
    }
  }

  if (hasAutotrack) {
    out.push(
      buildAutotrackEndpoint({
        parentDeviceId: parentInfo.id,
        parentStableId: parentInfo.stableId,
        parentName: parentInfo.name,
      }),
    )
  }

  if (hasPrivacy) {
    out.push(
      buildPrivacyEndpoint({
        parentDeviceId: parentInfo.id,
        parentStableId: parentInfo.stableId,
        parentName: parentInfo.name,
      }),
    )
  }

  // Child accessories — one endpoint per child that exposes the
  // `switch` cap. Skip doorbell children (they only carry the press
  // signal on the parent's DoorbellEventSource).
  for (const child of children) {
    const role = child.role ?? null
    if (role === 'doorbell') continue
    const childInfo = await loadBoundDeviceInfo(child, api).catch(() => null)
    if (!childInfo) continue
    if (!childInfo.capNames.includes(CAP_SWITCH)) continue
    const kind: ChildAccessoryKind = classifyChildKind(child.type, role)
    out.push(
      buildChildAccessoryEndpoint({
        parentDeviceId: parentInfo.id,
        parentName: parentInfo.name,
        childDeviceId: childInfo.id,
        childStableId: childInfo.stableId,
        childName: child.name,
        kind,
        hasBrightness: childInfo.capNames.includes(CAP_BRIGHTNESS),
      }),
    )
  }

  return out
}

/**
 * The panel endpoint, with what the panel says it accepts.
 *
 * A `getStatus` that fails leaves `availableModes` empty and `requiresCode`
 * false, and those are the UNKNOWN readings, not assertions: an empty mode
 * list makes discovery declare all three arm states (`supportedArmStatesFor`)
 * rather than publishing a panel that can only be disarmed, and the directive
 * handler re-reads the panel before it commands anything, so a PIN discovered
 * later is still honoured. The blind read is logged against the device id.
 */
async function buildAlarmPanelEndpointFor(
  info: BoundDeviceInfo,
  api: AddonApi,
  deps: DeviceBuildContext,
): Promise<AlexaEndpoint> {
  const status = await api.alarmPanel.getStatus
    .query({ deviceId: info.id })
    .catch((err: unknown) => {
      deps.logger.warn('alexa discovery: alarmPanel.getStatus failed — declaring every arm state', {
        tags: { deviceId: info.id },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return null
    })
  const parsed = AlarmPanelStatusSchema.pick({
    availableModes: true,
    requiresCode: true,
  }).safeParse(status)
  if (!parsed.success && status !== null) {
    deps.logger.warn('alexa discovery: panel status did not match the cap schema', {
      tags: { deviceId: info.id },
    })
  }
  const availableModes = parsed.success ? parsed.data.availableModes : []
  const requiresCode = parsed.success ? parsed.data.requiresCode : false

  deps.logger.info('alexa discovery: built alarm panel endpoint', {
    tags: { deviceId: info.id },
    meta: { name: info.name, availableModes: [...availableModes], requiresCode },
  })

  return buildAlarmPanelEndpoint({
    deviceId: info.id,
    stableId: info.stableId,
    friendlyName: info.name,
    availableModes,
    requiresCode,
  })
}

interface DeviceLike {
  readonly id: number
  readonly stableId: string
  readonly name: string
  readonly features: readonly string[]
  readonly role?: string | null
}

/** Devices whose "deliberately not published" reason was already logged. */
const loggedSkips = new Set<string>()

function logSkippedOnce(logger: IScopedLogger, deviceId: number, reasons: readonly string[]): void {
  for (const reason of reasons) {
    const key = `${deviceId}|${reason}`
    if (loggedSkips.has(key)) continue
    loggedSkips.add(key)
    logger.info('alexa discovery: device not published', {
      tags: { deviceId },
      meta: { reason },
    })
  }
}

/** The slices the adapters need to decide an endpoint's shape (a cover's
 *  position / tilt support). A read that fails leaves that slice out - the
 *  adapter then falls back to the device's declared features. */
async function readDiscoverySlices(
  api: AddonApi,
  info: BoundDeviceInfo,
  logger: IScopedLogger,
): Promise<Readonly<Record<string, unknown>>> {
  const reads = await Promise.all(
    discoveryReadCaps(info.capNames).map(async (capName): Promise<[string, unknown] | null> => {
      try {
        return [capName, await api.deviceState.getCapSlice.query({ deviceId: info.id, capName })]
      } catch (err: unknown) {
        logger.debug('alexa discovery: a shape-deciding slice could not be read', {
          tags: { deviceId: info.id },
          meta: { capName, error: err instanceof Error ? err.message : String(err) },
        })
        return null
      }
    }),
  )
  return Object.fromEntries(reads.filter((r): r is [string, unknown] => r !== null))
}

async function loadBoundDeviceInfo(device: DeviceLike, api: AddonApi): Promise<BoundDeviceInfo> {
  const bindings = await api.deviceManager.getBindings.query({ deviceId: device.id })
  const capNames: readonly string[] = (bindings.entries as readonly BindingEntry[]).map(
    (e) => e.capName,
  )
  return {
    id: device.id,
    stableId: device.stableId,
    name: device.name,
    features: device.features,
    role: device.role ?? null,
    capNames,
  }
}

async function fetchPtzPresetNames(deviceId: number, api: AddonApi): Promise<readonly string[]> {
  const presets = await api.ptz.getPresets.query({ deviceId })
  return presets
    .filter(isAlexaRecallablePreset)
    .map((p) => p.name)
    .filter((n: string) => n.length > 0)
}

function classifyChildKind(deviceType: string, role: string | null): ChildAccessoryKind {
  if (role === 'floodlight' || role === 'spotlight' || role === 'nightvision') return 'light'
  if (role === 'siren') return 'siren'
  if (deviceType === 'light') return 'light'
  if (deviceType === 'siren') return 'siren'
  return 'switch'
}

// ── Response helpers ────────────────────────────────────────────────

function discoveryResponse(header: DirectiveHeader, endpoints: readonly AlexaEndpoint[]): unknown {
  return {
    event: {
      header: {
        namespace: 'Alexa.Discovery',
        name: 'Discover.Response',
        messageId: header.messageId,
        payloadVersion: '3',
      },
      payload: { endpoints },
    },
  }
}
