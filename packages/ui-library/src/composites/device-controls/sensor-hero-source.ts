/**
 * Where a sensor hero reads its number. The live proxy slice is the
 * usual source. A composed device publishes the same reading on the
 * snapshot before that proxy has a binding, and it has no running-state
 * to stand in for the reading. An answered snapshot with no primary
 * field is quiet — it must not say the value is still on its way.
 */
import { COMPOSER_ADDON_ID } from '@camstack/types'
import type { SensorDescriptor } from './sensor-value-atom'

export type SnapshotStatus = 'pending' | 'error' | 'success'

export type SensorHeroResolution =
  | { readonly kind: 'value'; readonly slice: unknown }
  | { readonly kind: 'awaiting' }
  | { readonly kind: 'quiet' }

export interface SensorHeroSourceInput {
  readonly addonId: string
  readonly role: string | null | undefined
  readonly descriptor: SensorDescriptor | undefined
  readonly capName: string | undefined
  readonly live: unknown
  readonly snapshotStatus: SnapshotStatus
  readonly snapshotCaps: unknown
}

/** Cap a role's primary reading is stored on. Kept beside the hero, not a second renderer. */
export const ROLE_OUTPUT_CAP: Readonly<Record<string, string>> = {
  'temperature-sensor': 'temperature-sensor',
  'humidity-sensor': 'humidity-sensor',
  'ambient-light-sensor': 'ambient-light-sensor',
  'pressure-sensor': 'pressure-sensor',
  'numeric-sensor': 'numeric-sensor',
  'wind-sensor': 'numeric-sensor',
  'rain-sensor': 'numeric-sensor',
  'uv-sensor': 'numeric-sensor',
  'solar-radiation-sensor': 'numeric-sensor',
  'soil-moisture-sensor': 'numeric-sensor',
  'power-sensor': 'power-meter',
  'energy-sensor': 'power-meter',
  'voltage-sensor': 'power-meter',
  'current-sensor': 'power-meter',
  'battery-sensor': 'numeric-sensor',
  'generic-sensor': 'numeric-sensor',
  'motion-sensor': 'motion',
  'pir-sensor': 'motion',
  'contact-sensor': 'contact',
  'smoke-sensor': 'smoke',
  'leak-sensor': 'flood',
  'co-sensor': 'carbon-monoxide',
  'binary-sensor': 'binary',
  presence: 'presence',
  'enum-sensor': 'enum-sensor',
  'datetime-sensor': 'enum-sensor',
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The descriptor can render this slice. `false` and `0` count; a missing field does not. */
export function sensorSliceReady(descriptor: SensorDescriptor, slice: unknown): boolean {
  if (!isRecord(slice)) return false
  if (descriptor.kind === 'presence') return typeof slice['state'] === 'string'
  if (descriptor.kind === 'string' || descriptor.kind === 'datetime') {
    return typeof slice['value'] === 'string' && slice['value'] !== ''
  }
  const value = slice[descriptor.field]
  if (descriptor.kind === 'numeric') return typeof value === 'number'
  return typeof value === 'boolean'
}

function capSlice(caps: unknown, capName: string | undefined): unknown {
  if (capName === undefined || !isRecord(caps)) return undefined
  return caps[capName]
}

/**
 * A battery group writes `battery.level`. The role's usual cap is
 * `numeric-sensor.value`. Hand the renderer a slice whose `value` is that
 * percentage so one numeric path draws both.
 */
function batteryPercentageSlice(caps: unknown): unknown {
  const battery = capSlice(caps, 'battery')
  if (!isRecord(battery) || typeof battery['level'] !== 'number') return undefined
  return { ...battery, value: battery['level'] }
}

function snapshotSlice(input: SensorHeroSourceInput): unknown {
  const direct = capSlice(input.snapshotCaps, input.capName)
  if (input.descriptor !== undefined && sensorSliceReady(input.descriptor, direct)) return direct
  if (input.role === 'battery-sensor' && input.descriptor?.kind === 'numeric') {
    return batteryPercentageSlice(input.snapshotCaps)
  }
  return undefined
}

export function resolveSensorHeroReading(input: SensorHeroSourceInput): SensorHeroResolution {
  const descriptor = input.descriptor
  if (descriptor !== undefined && sensorSliceReady(descriptor, input.live)) {
    return { kind: 'value', slice: input.live }
  }
  const fromSnapshot = snapshotSlice(input)
  if (descriptor !== undefined && sensorSliceReady(descriptor, fromSnapshot)) {
    return { kind: 'value', slice: fromSnapshot }
  }
  if (input.addonId === COMPOSER_ADDON_ID && input.snapshotStatus === 'success') {
    return { kind: 'quiet' }
  }
  return { kind: 'awaiting' }
}
