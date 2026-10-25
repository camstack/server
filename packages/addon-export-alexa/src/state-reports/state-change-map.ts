/**
 * What a device's state change means for Alexa (R3, D776).
 *
 * Every cap state change on the hub arrives as ONE event —
 * `DeviceStateChanged {deviceId, capName, slice}` (the device-state mirror;
 * the per-cap `on…Changed` events the cap files declare are never emitted).
 * This maps one such change to the Alexa properties it changes, on the
 * endpoints this addon last published (`exportedEndpoints`): the alarm panel's
 * `armState` / `burglaryAlarm`, a privacy or autotrack switch's `powerState`,
 * an accessory's `powerState` / `brightness`, and — for `device-status` — the
 * device's connectivity.
 *
 * Pure: no I/O, so the mapping is pinned by a spec without an event bus.
 */
import { AlarmPanelStatusSchema } from '@camstack/types'
import { z } from 'zod'
import { parseCameraEndpointId } from '../handlers/endpoint-id.js'
import { genericPropertiesFor } from '../handlers/generic-state.js'
import { type PropertyShaping, shapingFor } from '../endpoints/adapters/index.js'
import { alexaArmStateFor, burglaryAlarmFor } from '../handlers/security-panel-arm-state.js'

export interface StateChange {
  readonly deviceId: number
  readonly capName: string
  readonly slice: Readonly<Record<string, unknown>>
}

export interface ReportedProperty {
  readonly namespace: string
  readonly name: string
  readonly value: unknown
  /** Set on an instanced interface (Range / Mode). */
  readonly instance?: string
}

export interface StateReport {
  /** The exposed device the endpoint is published under (visibility gate). */
  readonly exposedDeviceId: number
  readonly endpointId: string
  /** The interface the properties belong to — Alexa must know the endpoint
   *  declares it, or the report is discarded (D76). */
  readonly interfaceName: string
  /** The instance of an instanced interface, when the report is for one. */
  readonly instance?: string
  readonly properties: readonly ReportedProperty[]
  /** How often this report may go out (D869); absent = on every change. */
  readonly shaping?: PropertyShaping
}

export type StateChangeOutcome =
  | { readonly kind: 'connectivity'; readonly deviceId: number; readonly online: boolean }
  | { readonly kind: 'reports'; readonly reports: readonly StateReport[] }

type EndpointKind =
  | 'camera'
  | 'privacy'
  | 'autotrack'
  | 'child'
  | 'alarm-panel'
  | 'detection'
  | 'generic'

interface IndexedEndpoint {
  readonly exposedDeviceId: number
  readonly endpointId: string
  readonly kind: EndpointKind
}

/** Every published endpoint, keyed by the device whose state drives it. */
function indexByDrivingDevice(
  exported: Readonly<Record<number, readonly string[]>>,
): ReadonlyMap<number, readonly IndexedEndpoint[]> {
  const out = new Map<number, IndexedEndpoint[]>()
  const add = (deviceId: number, entry: IndexedEndpoint): void => {
    const list = out.get(deviceId) ?? []
    list.push(entry)
    out.set(deviceId, list)
  }
  for (const [key, ids] of Object.entries(exported)) {
    const exposedDeviceId = Number(key)
    for (const endpointId of ids) {
      const parsed = parseCameraEndpointId(endpointId)
      switch (parsed.kind) {
        case 'camera':
          add(parsed.deviceId, { exposedDeviceId, endpointId, kind: 'camera' })
          break
        case 'privacy':
        case 'autotrack':
          add(parsed.parentDeviceId, { exposedDeviceId, endpointId, kind: parsed.kind })
          break
        case 'child':
          add(parsed.childDeviceId, { exposedDeviceId, endpointId, kind: 'child' })
          break
        case 'alarm-panel':
          add(parsed.deviceId, { exposedDeviceId, endpointId, kind: 'alarm-panel' })
          break
        case 'detection':
          add(parsed.deviceId, { exposedDeviceId, endpointId, kind: 'detection' })
          break
        case 'generic':
          add(parsed.deviceId, { exposedDeviceId, endpointId, kind: 'generic' })
          break
        case 'invalid':
          break
      }
    }
  }
  return out
}

const EnabledSchema = z.object({ enabled: z.boolean() })
const OnSchema = z.object({ on: z.boolean() })
const PercentageSchema = z.object({ percentage: z.number() })
const OnlineSchema = z.object({ online: z.boolean() })

function power(on: boolean): ReportedProperty {
  return { namespace: 'Alexa.PowerController', name: 'powerState', value: on ? 'ON' : 'OFF' }
}

export function stateReportsFor(
  change: StateChange,
  exported: Readonly<Record<number, readonly string[]>>,
): StateChangeOutcome | null {
  if (change.capName === 'device-status') {
    const parsed = OnlineSchema.safeParse(change.slice)
    return parsed.success
      ? { kind: 'connectivity', deviceId: change.deviceId, online: parsed.data.online }
      : null
  }
  const endpoints = indexByDrivingDevice(exported).get(change.deviceId) ?? []
  const reports: StateReport[] = []
  const of = (kind: EndpointKind): ReadonlyArray<{ exposedDeviceId: number; endpointId: string }> =>
    endpoints
      .filter((e) => e.kind === kind)
      .map((e) => ({ exposedDeviceId: e.exposedDeviceId, endpointId: e.endpointId }))

  // A device exported as its own endpoint (R5): the shared slice mapping.
  for (const property of genericPropertiesFor(change.capName, change.slice)) {
    const shaping = shapingFor(change.capName, property)
    for (const e of of('generic')) {
      reports.push({
        ...e,
        interfaceName: property.namespace,
        ...(property.instance !== undefined ? { instance: property.instance } : {}),
        properties: [property],
        ...(shaping !== null ? { shaping } : {}),
      })
    }
  }

  switch (change.capName) {
    case 'alarm-panel': {
      const parsed = AlarmPanelStatusSchema.pick({ state: true, targetMode: true }).safeParse(
        change.slice,
      )
      if (!parsed.success) return null
      for (const e of of('alarm-panel')) {
        reports.push({
          ...e,
          interfaceName: 'Alexa.SecurityPanelController',
          properties: [
            {
              namespace: 'Alexa.SecurityPanelController',
              name: 'armState',
              value: alexaArmStateFor(parsed.data.state, parsed.data.targetMode ?? null),
            },
            {
              namespace: 'Alexa.SecurityPanelController',
              name: 'burglaryAlarm',
              value: burglaryAlarmFor(parsed.data.state),
            },
          ],
        })
      }
      break
    }
    case 'privacy-mask':
    case 'ptz-autotrack': {
      const parsed = EnabledSchema.safeParse(change.slice)
      if (!parsed.success) return null
      const kind: EndpointKind = change.capName === 'privacy-mask' ? 'privacy' : 'autotrack'
      for (const e of of(kind)) {
        reports.push({
          ...e,
          interfaceName: 'Alexa.PowerController',
          properties: [power(parsed.data.enabled)],
        })
      }
      break
    }
    case 'switch': {
      const parsed = OnSchema.safeParse(change.slice)
      if (!parsed.success) break
      for (const e of of('child')) {
        reports.push({
          ...e,
          interfaceName: 'Alexa.PowerController',
          properties: [power(parsed.data.on)],
        })
      }
      break
    }
    case 'brightness': {
      const parsed = PercentageSchema.safeParse(change.slice)
      if (!parsed.success) break
      const value = Math.max(0, Math.min(100, Math.round(parsed.data.percentage)))
      for (const e of of('child')) {
        reports.push({
          ...e,
          interfaceName: 'Alexa.BrightnessController',
          properties: [{ namespace: 'Alexa.BrightnessController', name: 'brightness', value }],
        })
      }
      break
    }
    default:
      break
  }
  return reports.length > 0 ? { kind: 'reports', reports } : null
}
