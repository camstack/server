/**
 * `Alexa/ReportState` handler.
 *
 * Alexa polls this directive whenever the app or an Echo device opens a
 * device tile and needs the current values for every property it declared
 * `retrievable: true` on. Without a real response Alexa shows "Unknown"
 * (battery level disappears, motion goes blank, the Echo Show camera
 * card hides the auxiliary rows).
 *
 * Per endpoint kind we collect the relevant capabilities:
 *
 *   - camera (`<deviceId>`)
 *       Alexa.MotionSensor.detectionState     (when the cam has `motion` cap)
 *
 *   - privacy (`<parent>__privacy`) and autotrack (`<parent>__autotrack`)
 *       Alexa.PowerController.powerState — reflects the underlying
 *       `privacy-mask` / `ptz-autotrack` state when readable, otherwise OFF.
 *
 *   - alarm panel (`<deviceId>__alarm`)
 *       Alexa.SecurityPanelController.armState + burglaryAlarm — both omitted
 *       when the panel cannot be read, because a guessed armState is a claim
 *       about whether a house is locked.
 *
 *   - child accessory (`<parent>__<child>`)
 *       Alexa.PowerController.powerState  (from `switch.getState`)
 *       Alexa.BrightnessController.brightness (when child also has `brightness`)
 *       An unreadable switch (e.g. the accessory of a sleeping battery camera,
 *       not spawned until it wakes) answers ENDPOINT_UNREACHABLE.
 *
 * `Alexa.EndpointHealth.connectivity` IS answered for every camera endpoint,
 * because every camera endpoint declares it: an endpoint whose health Alexa
 * does not know is one the phone app refuses to stream (D770). An unreadable
 * device-status reads as `OK` — a hub-side read glitch is not an offline
 * camera.
 *
 * Caps the cam doesn't expose are silently omitted — Alexa accepts a
 * partial property list and renders only what's present.
 */
import type { AddonApi, AddonContext, IScopedLogger } from '@camstack/types'
import { AlarmPanelStatusSchema } from '@camstack/types'
import { readConnectivity } from '../connectivity.js'
import type { VerifiedDirectiveIdentity } from '../directive-router.js'
import { type DetectionSensorClass, parseCameraEndpointId } from './endpoint-id.js'
import { errorEnvelope } from './error-envelope.js'
import { GENERIC_STATE_CAPS, genericPropertiesFor } from './generic-state.js'
import { alexaArmStateFor, burglaryAlarmFor } from './security-panel-arm-state.js'
import type { DirectiveHeader, EndpointRef } from './types.js'

export interface ReportStateContext {
  readonly ctx: AddonContext
  readonly logger: IScopedLogger
  /**
   * Whether a camera's detection class is present right now (R1, the
   * detection tracker). Absent ⇒ every detection sensor reads NOT_DETECTED.
   */
  readonly detectionPresent?: (deviceId: number, cls: DetectionSensorClass) => boolean
}

interface AlexaProperty {
  readonly namespace: string
  readonly name: string
  /** Set on an instanced interface (Range / Mode). */
  readonly instance?: string
  readonly value: unknown
  readonly timeOfSample: string
  readonly uncertaintyInMilliseconds: number
}

export async function handleReportState(
  header: DirectiveHeader,
  endpointRaw: unknown,
  deps: ReportStateContext,
  _callerIdentity: VerifiedDirectiveIdentity,
): Promise<unknown> {
  const endpoint = endpointRaw as EndpointRef | undefined
  const endpointId = endpoint?.endpointId
  if (typeof endpointId !== 'string') {
    return errorEnvelope(header, 'INVALID_DIRECTIVE', 'missing endpoint.endpointId')
  }
  const parsed = parseCameraEndpointId(endpointId)
  if (parsed.kind === 'invalid') {
    return errorEnvelope(header, 'INVALID_DIRECTIVE', parsed.reason)
  }

  const api = deps.ctx.api
  const properties: AlexaProperty[] = []
  const nowIso = new Date().toISOString()

  try {
    if (parsed.kind === 'camera') {
      await collectCameraProperties(api, parsed.deviceId, properties, nowIso, deps.logger)
    } else if (parsed.kind === 'privacy') {
      await collectPrivacyProperties(api, parsed.parentDeviceId, properties, nowIso, deps.logger)
    } else if (parsed.kind === 'autotrack') {
      await collectAutotrackProperties(api, parsed.parentDeviceId, properties, nowIso, deps.logger)
    } else if (parsed.kind === 'child') {
      await collectChildProperties(api, parsed.childDeviceId, properties, nowIso, deps.logger)
    } else if (parsed.kind === 'alarm-panel') {
      await collectAlarmPanelProperties(api, parsed.deviceId, properties, nowIso, deps.logger)
    } else if (parsed.kind === 'generic') {
      await collectGenericProperties(api, parsed.deviceId, properties, nowIso, deps.logger)
    } else if (parsed.kind === 'detection') {
      properties.push({
        namespace: 'Alexa.MotionSensor',
        name: 'detectionState',
        value: deps.detectionPresent?.(parsed.deviceId, parsed.detectionClass)
          ? 'DETECTED'
          : 'NOT_DETECTED',
        timeOfSample: nowIso,
        uncertaintyInMilliseconds: 0,
      })
      properties.push({
        namespace: 'Alexa.EndpointHealth',
        name: 'connectivity',
        value: { value: await readConnectivity(api, parsed.deviceId, deps.logger) },
        timeOfSample: nowIso,
        uncertaintyInMilliseconds: 0,
      })
    }
  } catch (err: unknown) {
    if (err instanceof ChildUnreachableError) {
      return errorEnvelope(header, 'ENDPOINT_UNREACHABLE', err.message)
    }
    deps.logger.warn('alexa report-state: collection failed', {
      meta: { endpointId, error: err instanceof Error ? err.message : String(err) },
    })
  }

  return {
    event: {
      header: {
        namespace: 'Alexa',
        name: 'StateReport',
        messageId: header.messageId,
        correlationToken: header.correlationToken,
        payloadVersion: '3',
      },
      endpoint: { endpointId },
      payload: {},
    },
    context: { properties },
  }
}

/**
 * A generic device (R5): every cap it has, read through its status, mapped by
 * the same function the proactive reports use. A cap the device does not have
 * fails its read and contributes nothing; connectivity is always answered.
 */
async function collectGenericProperties(
  api: AddonApi,
  deviceId: number,
  properties: AlexaProperty[],
  timeOfSample: string,
  logger: IScopedLogger,
): Promise<void> {
  const reads = await Promise.all(
    GENERIC_STATE_CAPS.map(async (capName) => {
      const status: unknown = await api.deviceState.getCapSlice
        .query({ deviceId, capName })
        .catch(() => null)
      return status === null ? [] : genericPropertiesFor(capName, status)
    }),
  )
  const seen = new Set<string>()
  for (const p of reads.flat()) {
    const key = `${p.namespace}#${p.instance ?? ''}.${p.name}`
    if (seen.has(key)) continue
    seen.add(key)
    properties.push({ ...p, timeOfSample, uncertaintyInMilliseconds: 0 })
  }
  properties.push({
    namespace: 'Alexa.EndpointHealth',
    name: 'connectivity',
    value: { value: await readConnectivity(api, deviceId, logger) },
    timeOfSample,
    uncertaintyInMilliseconds: 0,
  })
}

function numberField(value: unknown, key: string): number | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = (value as Record<string, unknown>)[key]
  return typeof raw === 'number' ? raw : null
}

function boolField(value: unknown, key: string): boolean | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = (value as Record<string, unknown>)[key]
  return typeof raw === 'boolean' ? raw : null
}

async function collectCameraProperties(
  api: AddonApi,
  deviceId: number,
  properties: AlexaProperty[],
  timeOfSample: string,
  logger: IScopedLogger,
): Promise<void> {
  properties.push({
    namespace: 'Alexa.EndpointHealth',
    name: 'connectivity',
    value: { value: await readConnectivity(api, deviceId, logger) },
    timeOfSample,
    uncertaintyInMilliseconds: 0,
  })
  const motion = await api.motion.getStatus.query({ deviceId }).catch((err: unknown) => {
    logger.info('alexa report-state: motion.getStatus skipped', {
      meta: { deviceId, error: err instanceof Error ? err.message : String(err) },
    })
    return null
  })
  const detected = boolField(motion, 'detected')
  if (detected !== null) {
    properties.push({
      namespace: 'Alexa.MotionSensor',
      name: 'detectionState',
      value: detected ? 'DETECTED' : 'NOT_DETECTED',
      timeOfSample,
      uncertaintyInMilliseconds: 0,
    })
  }
}

/**
 * The panel's two declared properties.
 *
 * Both are omitted when the panel cannot be read — an `armState` we guessed
 * would be a claim about whether a house is locked, and Alexa rendering the
 * endpoint as unavailable is the truthful outcome of a panel nobody reached.
 * The failure is logged with the device id, never swallowed.
 */
async function collectAlarmPanelProperties(
  api: AddonApi,
  deviceId: number,
  properties: AlexaProperty[],
  timeOfSample: string,
  logger: IScopedLogger,
): Promise<void> {
  const status = await api.alarmPanel.getStatus.query({ deviceId }).catch((err: unknown) => {
    logger.warn(
      'alexa report-state: alarmPanel.getStatus FAILED — Alexa will show the panel as unavailable',
      {
        tags: { deviceId },
        meta: { error: err instanceof Error ? err.message : String(err) },
      },
    )
    return null
  })
  const parsed = AlarmPanelStatusSchema.pick({ state: true, targetMode: true }).safeParse(status)
  if (!parsed.success) {
    if (status !== null) {
      logger.warn('alexa report-state: panel status did not match the cap schema — omitting', {
        tags: { deviceId },
      })
    }
    return
  }
  properties.push({
    namespace: 'Alexa.SecurityPanelController',
    name: 'armState',
    value: alexaArmStateFor(parsed.data.state, parsed.data.targetMode ?? null),
    timeOfSample,
    uncertaintyInMilliseconds: 0,
  })
  properties.push({
    namespace: 'Alexa.SecurityPanelController',
    name: 'burglaryAlarm',
    value: burglaryAlarmFor(parsed.data.state),
    timeOfSample,
    uncertaintyInMilliseconds: 0,
  })
}

async function collectPrivacyProperties(
  api: AddonApi,
  parentDeviceId: number,
  properties: AlexaProperty[],
  timeOfSample: string,
  _logger: IScopedLogger,
): Promise<void> {
  const status = await api.privacyMask.getStatus
    .query({ deviceId: parentDeviceId })
    .catch(() => null)
  const enabled = Boolean((status as { enabled?: unknown } | null)?.enabled)
  properties.push({
    namespace: 'Alexa.PowerController',
    name: 'powerState',
    value: enabled ? 'ON' : 'OFF',
    timeOfSample,
    uncertaintyInMilliseconds: 0,
  })
}

async function collectAutotrackProperties(
  api: AddonApi,
  parentDeviceId: number,
  properties: AlexaProperty[],
  timeOfSample: string,
  _logger: IScopedLogger,
): Promise<void> {
  const status = await api.ptzAutotrack.getStatus
    .query({ deviceId: parentDeviceId })
    .catch(() => null)
  const enabled = Boolean((status as { enabled?: unknown } | null)?.enabled)
  properties.push({
    namespace: 'Alexa.PowerController',
    name: 'powerState',
    value: enabled ? 'ON' : 'OFF',
    timeOfSample,
    uncertaintyInMilliseconds: 0,
  })
}

/** The child's `switch` cannot be read: answered `ENDPOINT_UNREACHABLE`. */
class ChildUnreachableError extends Error {}

/** One warning per child per window (a sleeping battery camera's accessories
 *  are polled by Alexa for as long as it sleeps). */
const CHILD_WARN_EVERY_MS = 10 * 60_000
const childWarnedAt = new Map<number, number>()

function warnChildUnreadable(logger: IScopedLogger, childDeviceId: number, error: string): void {
  const now = Date.now()
  const last = childWarnedAt.get(childDeviceId)
  if (last !== undefined && now - last < CHILD_WARN_EVERY_MS) return
  childWarnedAt.set(childDeviceId, now)
  logger.warn(
    'alexa report-state: child accessory switch unreadable — answered ENDPOINT_UNREACHABLE',
    {
      // Seen for the accessories of a sleeping battery camera, which the
      // provider spawns only once the camera wakes and probes.
      meta: { childDeviceId, error, repeatsSuppressedForMs: CHILD_WARN_EVERY_MS },
    },
  )
}

async function collectChildProperties(
  api: AddonApi,
  childDeviceId: number,
  properties: AlexaProperty[],
  timeOfSample: string,
  logger: IScopedLogger,
): Promise<void> {
  let failure: string | null = null
  const switchState = await api.switch.getStatus
    .query({ deviceId: childDeviceId })
    .catch((err: unknown) => {
      failure = err instanceof Error ? err.message : String(err)
      return null
    })
  if (switchState === null || switchState === undefined) {
    warnChildUnreadable(logger, childDeviceId, failure ?? 'no payload')
    throw new ChildUnreachableError(`accessory ${childDeviceId} cannot be read right now`)
  }
  childWarnedAt.delete(childDeviceId)
  logger.debug('alexa report-state: switch.getStatus payload', {
    meta: { childDeviceId, payload: switchState },
  })
  const on = boolField(switchState, 'on')
  if (on !== null) {
    properties.push({
      namespace: 'Alexa.PowerController',
      name: 'powerState',
      value: on ? 'ON' : 'OFF',
      timeOfSample,
      uncertaintyInMilliseconds: 0,
    })
  }

  const brightness = await api.brightness.getStatus
    .query({ deviceId: childDeviceId })
    .catch(() => null)
  const level = numberField(brightness, 'percentage')
  if (level !== null) {
    properties.push({
      namespace: 'Alexa.BrightnessController',
      name: 'brightness',
      value: Math.max(0, Math.min(100, Math.round(level))),
      timeOfSample,
      uncertaintyInMilliseconds: 0,
    })
  }
}
