/**
 * The UPS of an Unraid server as one Sensor device (role `ups`): its `battery` and
 * `power-meter` slices and the readings that have no cap field (status, runtime, health,
 * load, voltages, nominal power) as numeric / enum sensor entities, all from the poll
 * snapshot. Pure.
 *
 * A reading the API did not report is unknown: an absent `power` field, a `null` level, an
 * entity that keeps its last value, never 0 (D393).
 */
import { type BatteryStatus, DeviceRole, DeviceType, type PowerMeterStatus } from '@dominevo/types'
import type { UnraidUpsInfo } from './unraid-client-contract.js'
import type { UnraidEntityDescriptor, UnraidEntityIdentity } from './unraid-mapping.js'
import { entityIdentity } from './unraid-mapping.js'

/** Clamp a charge percentage into 0..100; a non-finite reading is unknown. */
function percent(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(100, value))
}

/** What the mains status string says about the battery's charging source. */
function chargingOf(status: string | null): BatteryStatus['charging'] {
  const normal = (status ?? '').toUpperCase().replace(/[^A-Z]/g, '')
  if (normal.length === 0) return 'unknown'
  if (normal.includes('ONBATT') || normal.includes('ONBATTERY')) return 'none'
  if (normal.includes('ONLINE') || normal.includes('CHARGING')) return 'dc'
  return 'unknown'
}

/** The `battery` slice of a UPS: charge, and the charging source from the mains status. */
export function upsBatteryStatus(ups: UnraidUpsInfo, now: number): BatteryStatus {
  return {
    level: percent(ups.chargeLevel),
    charging: chargingOf(ups.status),
    sleeping: false,
    lastUpdated: now,
  }
}

/** The `power-meter` slice: the power drawn now; the field is absent when not reported. */
export function upsPowerMeterStatus(ups: UnraidUpsInfo, now: number): PowerMeterStatus {
  return {
    ...(ups.currentPowerW !== null ? { power: Math.max(0, ups.currentPowerW) } : {}),
    lastFetchedAt: now,
  }
}

function numeric(
  key: string,
  name: string,
  quantity: 'percentage' | 'voltage' | 'power' | 'duration',
  value: number | null,
): UnraidEntityDescriptor {
  return {
    key,
    kind: 'numeric',
    capName: 'numeric-sensor',
    deviceType: DeviceType.Sensor,
    name,
    role: DeviceRole.NumericSensor,
    numeric: { value, quantity },
  }
}

function enumReading(key: string, name: string, value: string | null): UnraidEntityDescriptor {
  return {
    key,
    kind: 'enum',
    capName: 'enum-sensor',
    deviceType: DeviceType.Sensor,
    name,
    role: DeviceRole.EnumSensor,
    // An unreported value leaves the entity on its last one: `enumValue` stays absent.
    ...(value !== null ? { enumValue: value } : {}),
  }
}

/** The readings of one UPS that no cap field carries. The key set is fixed, in a fixed order. */
export function upsEntityDescriptors(ups: UnraidUpsInfo): readonly UnraidEntityDescriptor[] {
  return [
    enumReading('ups_status', 'Status', ups.status),
    numeric('ups_runtime', 'Estimated runtime', 'duration', ups.estimatedRuntimeS),
    enumReading('ups_battery_health', 'Battery health', ups.batteryHealth),
    numeric('ups_load', 'Load', 'percentage', percent(ups.loadPercent)),
    numeric('ups_input_voltage', 'Input voltage', 'voltage', ups.inputVoltage),
    numeric('ups_output_voltage', 'Output voltage', 'voltage', ups.outputVoltage),
    numeric('ups_nominal_power', 'Nominal power', 'power', ups.nominalPowerW),
  ]
}

/** The persisted identity list of a UPS device (what its accessory children are spawned from). */
export function upsEntityIdentities(ups: UnraidUpsInfo): readonly UnraidEntityIdentity[] {
  return upsEntityDescriptors(ups).map(entityIdentity)
}
