/**
 * `ops_device` and `ops_unhealthy_devices`: why one device — or any device —
 * is not doing its job, with the reason typed.
 *
 * Two rules decide every verdict here:
 *  - DISABLED is not BROKEN (D62). A function an operator switched off is named
 *    as switched off; it is never listed as a fault.
 *  - A stage the status call could not read supports no conclusion (D315): it is
 *    reported as `unknown` with the hub's own reason, never as healthy or absent.
 */
import { z } from 'zod'
import type { McpContext } from './context.js'
import { cap, readQuery, withHub, type NoSessionResult, type Read } from './ops-hub.js'
import type { HubClient } from '@camstack/develop'

const DeviceSchema = z.looseObject({
  id: z.number(),
  name: z.string(),
  type: z.string().optional(),
  addonId: z.string().optional(),
  location: z.string().nullable().optional(),
  disabled: z.boolean().optional(),
  online: z.boolean().optional(),
  isCamera: z.boolean().optional(),
  features: z.array(z.string()).optional(),
})
const NullableDeviceSchema = DeviceSchema.nullable()
const DeviceListSchema = z.array(DeviceSchema)

const BindingsSchema = z.looseObject({
  entries: z.array(
    z.looseObject({
      capName: z.string(),
      kind: z.string(),
      providerAddonId: z.string(),
      providerNodeId: z.string(),
    }),
  ),
})

/** The per-cap status aggregate: only the freshness fields are read, never a value. */
const StatusAggregateSchema = z.record(z.string(), z.unknown())

const DegradationSchema = z.looseObject({
  stage: z.string(),
  reason: z.string(),
  elapsedMs: z.number().optional(),
})

const CameraStatusSchema = z.looseObject({
  deviceId: z.number(),
  assignment: z.looseObject({
    detectionNodeId: z.string().nullable(),
    decoderNodeId: z.string().nullable(),
    sourceNodeId: z.string().nullable(),
    /** Why a stage sits where it does; `armed:on-motion` means idle by design. */
    reasons: z.record(z.string(), z.string().optional()).optional(),
  }),
  broker: z
    .looseObject({
      profiles: z.array(
        z.looseObject({
          profile: z.string(),
          status: z.string(),
          subscribers: z.number(),
        }),
      ),
    })
    .nullable(),
  detection: z
    .looseObject({
      nodeId: z.string(),
      phase: z.string(),
      actualFps: z.number(),
      configuredFps: z.number(),
      provisioning: z.looseObject({
        state: z.string(),
        error: z.string().optional(),
      }),
    })
    .nullable(),
  recording: z
    .looseObject({
      mode: z.string(),
      active: z.boolean(),
      storageBytes: z.number(),
    })
    .nullable(),
  switchedOff: z.array(z.string()),
  degraded: z.array(DegradationSchema),
  fetchedAt: z.number(),
})
type CameraStatus = z.infer<typeof CameraStatusSchema>
const CameraStatusListSchema = z.array(CameraStatusSchema)

const ObjectEventSchema = z.looseObject({
  id: z.number(),
  timestamp: z.number(),
  className: z.string().optional(),
  trackId: z.string().optional(),
})
const ObjectEventsSchema = z.array(ObjectEventSchema)

export const BINDING_LIMIT = 40
export const EVENT_LIMIT = 5
export const UNHEALTHY_LIMIT = 50

export interface WhyOff {
  readonly function: string
  readonly reason: string
}

export interface PipelineSummary {
  readonly detectionNodeId: string | null
  readonly decoderNodeId: string | null
  readonly sourceNodeId: string | null
  readonly detection: {
    readonly phase: string
    readonly actualFps: number
    readonly provisioning: string
  } | null
  readonly brokerProfiles: readonly { readonly profile: string; readonly status: string }[] | null
}

export interface DeviceReport {
  readonly status: 'ok'
  readonly deviceId: number
  /** `false` only when the hub ANSWERED "no such device"; an unanswered read is in `unavailable`. */
  readonly found: boolean | null
  readonly device?: {
    readonly name: string
    readonly type: string | null
    readonly addonId: string | null
    readonly location: string | null
    readonly online: boolean | null
    readonly disabled: boolean
  }
  readonly nodes?: readonly string[]
  readonly bindings?: {
    readonly count: number
    readonly caps: readonly string[]
    readonly truncated: number
  }
  readonly runtimeState?: {
    /** Age of the newest `lastFetchedAt` any capability reports; `null` = none reports one. */
    readonly newestFetchAgeMs: number | null
    readonly oldestFetchAgeMs: number | null
    readonly statusChangedAgeMs: number | null
  }
  readonly pipeline?: PipelineSummary | null
  readonly recording?: {
    readonly mode: string
    readonly active: boolean
  } | null
  readonly switchedOff?: readonly string[]
  /** `false`: the switch read was cut short, so an empty `switchedOff` claims nothing. */
  readonly switchedOffKnown?: boolean
  readonly whyOff: readonly WhyOff[]
  readonly unknownStages: readonly {
    readonly stage: string
    readonly reason: string
  }[]
  readonly recentEvents?: readonly {
    readonly id: number
    readonly timestamp: number
    readonly className: string | null
    readonly trackId: string | null
  }[]
  /** Parts of the answer the hub did not give, with its reason. */
  readonly unavailable: { readonly [part: string]: string }
}

function freshness(
  aggregate: z.infer<typeof StatusAggregateSchema>,
  now: number,
): NonNullable<DeviceReport['runtimeState']> {
  const fetched: number[] = []
  let changed: number | null = null
  for (const [capName, value] of Object.entries(aggregate)) {
    const parsed = z
      .looseObject({
        lastFetchedAt: z.number().optional(),
        lastChangedAt: z.number().optional(),
      })
      .safeParse(value)
    if (!parsed.success) continue
    const at = parsed.data.lastFetchedAt
    if (at !== undefined && at > 0) fetched.push(at)
    if (capName === 'device-status' && parsed.data.lastChangedAt !== undefined) {
      changed = parsed.data.lastChangedAt
    }
  }
  return {
    newestFetchAgeMs: fetched.length === 0 ? null : Math.max(0, now - Math.max(...fetched)),
    oldestFetchAgeMs: fetched.length === 0 ? null : Math.max(0, now - Math.min(...fetched)),
    statusChangedAgeMs: changed === null || changed <= 0 ? null : now - changed,
  }
}

function pipelineOf(status: CameraStatus): PipelineSummary {
  return {
    detectionNodeId: status.assignment.detectionNodeId,
    decoderNodeId: status.assignment.decoderNodeId,
    sourceNodeId: status.assignment.sourceNodeId,
    detection: status.detection
      ? {
          phase: status.detection.phase,
          actualFps: status.detection.actualFps,
          provisioning: status.detection.provisioning.state,
        }
      : null,
    brokerProfiles: status.broker
      ? status.broker.profiles.map((p) => ({
          profile: p.profile,
          status: p.status,
        }))
      : null,
  }
}

/** Why functions of one camera are off or unreadable — D62's disabled-vs-broken. */
export function whyOff(status: CameraStatus, deviceDisabled: boolean): WhyOff[] {
  const out: WhyOff[] = []
  if (deviceDisabled)
    out.push({
      function: 'device',
      reason: 'the device is disabled by an operator',
    })
  for (const id of status.switchedOff) {
    out.push({
      function: id,
      reason: 'switched off by an operator (not a fault)',
    })
  }
  return out
}

export async function opsDevice(
  ctx: McpContext,
  deviceId: number,
  now: number = Date.now(),
): Promise<DeviceReport | NoSessionResult> {
  return withHub(ctx, async ({ client }) => {
    const unavailable: { [part: string]: string } = {}
    const [deviceRead, bindingsRead, aggregateRead] = await Promise.all([
      readQuery(client, 'deviceManager.getDevice', { deviceId }, NullableDeviceSchema),
      readQuery(client, 'deviceManager.getBindings', { deviceId }, BindingsSchema),
      readQuery(
        client,
        'deviceManager.getDeviceStatusAggregate',
        { deviceId },
        StatusAggregateSchema,
      ),
    ])
    if (deviceRead.ok && deviceRead.value === null) {
      return {
        status: 'ok' as const,
        deviceId,
        found: false,
        whyOff: [],
        unknownStages: [],
        unavailable,
      }
    }
    if (!deviceRead.ok) unavailable['device'] = deviceRead.reason
    const device = deviceRead.ok ? deviceRead.value : null

    let bindings: DeviceReport['bindings']
    let nodes: readonly string[] | undefined
    if (bindingsRead.ok) {
      const names = [...new Set(bindingsRead.value.entries.map((e) => e.capName))]
      const capped = cap(names, BINDING_LIMIT)
      bindings = {
        count: names.length,
        caps: capped.items,
        truncated: capped.truncated,
      }
      nodes = [...new Set(bindingsRead.value.entries.map((e) => e.providerNodeId))]
    } else {
      unavailable['bindings'] = bindingsRead.reason
    }

    let runtimeState: DeviceReport['runtimeState']
    if (aggregateRead.ok) runtimeState = freshness(aggregateRead.value, now)
    else unavailable['runtimeState'] = aggregateRead.reason

    let pipeline: PipelineSummary | null | undefined
    let recording: DeviceReport['recording']
    let switchedOff: readonly string[] | undefined
    let switchedOffKnown: boolean | undefined
    let why: WhyOff[] =
      device?.disabled === true
        ? [
            {
              function: 'device',
              reason: 'the device is disabled by an operator',
            },
          ]
        : []
    let unknownStages: { stage: string; reason: string }[] = []
    let recentEvents: DeviceReport['recentEvents']

    if (device?.isCamera === true) {
      const [statusRead, eventsRead] = await Promise.all([
        readQuery(client, 'pipelineOrchestrator.getCameraStatus', { deviceId }, CameraStatusSchema),
        readQuery(
          client,
          'pipelineAnalytics.getObjectEvents',
          { deviceId, limit: EVENT_LIMIT, projection: 'slim' },
          ObjectEventsSchema,
        ),
      ])
      if (statusRead.ok) {
        const status = statusRead.value
        pipeline = pipelineOf(status)
        recording = status.recording
          ? { mode: status.recording.mode, active: status.recording.active }
          : null
        switchedOff = status.switchedOff
        switchedOffKnown = !status.degraded.some((d) => d.stage === 'switches')
        why = whyOff(status, device.disabled === true)
        unknownStages = status.degraded.map((d) => ({
          stage: d.stage,
          reason: d.reason,
        }))
      } else {
        unavailable['cameraStatus'] = statusRead.reason
      }
      if (eventsRead.ok) {
        recentEvents = eventsRead.value.map((e) => ({
          id: e.id,
          timestamp: e.timestamp,
          className: e.className ?? null,
          trackId: e.trackId ?? null,
        }))
      } else {
        unavailable['recentEvents'] = eventsRead.reason
      }
    }

    return {
      status: 'ok' as const,
      deviceId,
      found: device === null ? null : true,
      ...(device
        ? {
            device: {
              name: device.name,
              type: device.type ?? null,
              addonId: device.addonId ?? null,
              location: device.location ?? null,
              online: device.online ?? null,
              disabled: device.disabled === true,
            },
          }
        : {}),
      ...(nodes ? { nodes } : {}),
      ...(bindings ? { bindings } : {}),
      ...(runtimeState ? { runtimeState } : {}),
      ...(pipeline !== undefined ? { pipeline } : {}),
      ...(recording !== undefined ? { recording } : {}),
      ...(switchedOff ? { switchedOff } : {}),
      ...(switchedOffKnown !== undefined ? { switchedOffKnown } : {}),
      whyOff: why,
      unknownStages,
      ...(recentEvents ? { recentEvents } : {}),
      unavailable,
    }
  })
}

// ---------------------------------------------------------------------------

export type UnhealthyCode =
  | 'offline'
  | 'detection-provisioning-failed'
  | 'detection-not-assigned'
  | 'recording-inactive'

export interface UnhealthyReason {
  readonly code: UnhealthyCode
  readonly detail: string
}

export interface UnhealthyDevice {
  readonly deviceId: number
  readonly name: string
  readonly reasons: readonly UnhealthyReason[]
}

export interface UnhealthyReport {
  readonly status: 'ok'
  readonly checked: number
  readonly unhealthy: readonly UnhealthyDevice[]
  readonly truncated: number
  /** Cameras whose status could not be fully read: unknown, never healthy. */
  readonly unknown: readonly {
    readonly deviceId: number
    readonly name: string
    readonly stages: readonly {
      readonly stage: string
      readonly reason: string
    }[]
  }[]
  readonly unavailable: { readonly [part: string]: string }
}

/** The typed reasons one camera is unhealthy; pure, driven by the status alone. */
export function cameraReasons(status: CameraStatus): UnhealthyReason[] {
  const out: UnhealthyReason[] = []
  const readable = (stage: string): boolean => !status.degraded.some((d) => d.stage === stage)
  const off = (id: string): boolean => status.switchedOff.includes(id)
  if (status.detection?.provisioning.state === 'failed' && !off('object-detection')) {
    out.push({
      code: 'detection-provisioning-failed',
      detail: status.detection.provisioning.error ?? 'detection provisioning failed',
    })
  }
  if (
    status.assignment.detectionNodeId === null &&
    !(status.assignment.reasons?.['detection'] ?? '').startsWith('armed:') &&
    !off('object-detection') &&
    readable('detection')
  ) {
    out.push({
      code: 'detection-not-assigned',
      detail: 'no node runs detection for this camera and it is not switched off',
    })
  }
  if (
    status.recording !== null &&
    status.recording.mode === 'continuous' &&
    !status.recording.active &&
    !off('recording') &&
    readable('recording')
  ) {
    out.push({
      code: 'recording-inactive',
      detail: 'continuous recording is configured but not recording and not switched off',
    })
  }
  return out
}

function readCameraStatuses(client: HubClient): Promise<Read<CameraStatus[]>> {
  return readQuery(client, 'pipelineOrchestrator.getCameraStatuses', {}, CameraStatusListSchema)
}

export async function opsUnhealthyDevices(
  ctx: McpContext,
): Promise<UnhealthyReport | NoSessionResult> {
  return withHub(ctx, async ({ client }) => {
    const unavailable: { [part: string]: string } = {}
    const [devicesRead, statusesRead] = await Promise.all([
      readQuery(client, 'deviceManager.listAll', { projection: 'slim' }, DeviceListSchema),
      readCameraStatuses(client),
    ])
    if (!devicesRead.ok) {
      return {
        status: 'ok' as const,
        checked: 0,
        unhealthy: [],
        truncated: 0,
        unknown: [],
        unavailable: { devices: devicesRead.reason },
      }
    }
    if (!statusesRead.ok) unavailable['cameraStatuses'] = statusesRead.reason
    const statuses = new Map<number, CameraStatus>(
      statusesRead.ok ? statusesRead.value.map((s) => [s.deviceId, s]) : [],
    )
    const unhealthy: UnhealthyDevice[] = []
    const unknown: UnhealthyReport['unknown'][number][] = []
    for (const device of devicesRead.value) {
      if (device.disabled === true) continue
      const reasons: UnhealthyReason[] = []
      if (device.online === false) {
        reasons.push({
          code: 'offline',
          detail: 'the provider reports the device offline',
        })
      }
      const status = statuses.get(device.id)
      if (status && device.online !== false) {
        reasons.push(...cameraReasons(status))
        if (status.degraded.length > 0) {
          unknown.push({
            deviceId: device.id,
            name: device.name,
            stages: status.degraded.map((d) => ({
              stage: d.stage,
              reason: d.reason,
            })),
          })
        }
      }
      if (reasons.length > 0) unhealthy.push({ deviceId: device.id, name: device.name, reasons })
    }
    const capped = cap(unhealthy, UNHEALTHY_LIMIT)
    return {
      status: 'ok' as const,
      checked: devicesRead.value.filter((d) => d.disabled !== true).length,
      unhealthy: capped.items,
      truncated: capped.truncated,
      unknown: unknown.slice(0, UNHEALTHY_LIMIT),
      unavailable,
    }
  })
}
