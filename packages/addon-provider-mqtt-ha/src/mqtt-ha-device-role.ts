import { DeviceRole, DeviceType, type InitialDeviceMeta } from '@camstack/types'
import type { MqttHaCap } from './mqtt-ha-domain-mapping.js'

/**
 * Primary cap → `DeviceRole`. Only caps that already name a role. A switch,
 * light (brightness/color), climate, event or power-meter has no single
 * role in `DeviceRole`, so the device stays unstamped.
 */
export function deviceRoleForPrimaryCap(cap: MqttHaCap | undefined): DeviceRole | null {
  switch (cap) {
    case 'contact':
      return DeviceRole.ContactSensor
    case 'motion':
      return DeviceRole.MotionSensor
    case 'flood':
      return DeviceRole.LeakSensor
    case 'vibration':
      return DeviceRole.VibrationSensor
    case 'tamper':
      return DeviceRole.TamperSensor
    case 'temperature-sensor':
      return DeviceRole.TemperatureSensor
    case 'humidity-sensor':
      return DeviceRole.HumiditySensor
    case 'ambient-light-sensor':
      return DeviceRole.AmbientLightSensor
    case 'air-quality-sensor':
      return DeviceRole.AirQualitySensor
    case 'numeric-sensor':
      return DeviceRole.NumericSensor
    case 'battery':
      return DeviceRole.BatterySensor
    case 'switch':
    case 'brightness':
    case 'color':
    case 'power-meter':
    case 'climate-control':
    case 'event-emitter':
    case 'ir-transmitter':
    case undefined:
      return null
  }
}

/**
 * Caps that are a READING of the world. A battery is not one (a plain temperature
 * sensor with a battery stays a temperature sensor); an actuator or an event source
 * is not either.
 */
const READING_CAPS: ReadonlySet<MqttHaCap> = new Set<MqttHaCap>([
  'contact',
  'motion',
  'flood',
  'vibration',
  'tamper',
  'temperature-sensor',
  'humidity-sensor',
  'ambient-light-sensor',
  'numeric-sensor',
  'power-meter',
])

/**
 * The role of a device: a `Sensor` that carries two or more distinct readings is an
 * ambient monitor; anything else keeps the role of its primary cap. The vendor is
 * one device here, so the call is safe (a Home Assistant provider cannot make it).
 */
export function deviceRoleForCapabilities(
  deviceType: DeviceType,
  capabilities: readonly MqttHaCap[],
): DeviceRole | null {
  const readings = new Set(capabilities.filter((c) => READING_CAPS.has(c)))
  if (deviceType === DeviceType.Sensor && readings.size >= 2) return DeviceRole.AmbientMonitor
  return deviceRoleForPrimaryCap(capabilities[0])
}

/** What one adopted plan contributes to the device meta row. */
export interface MqttHaInitialMetaInput {
  readonly deviceType: DeviceType
  readonly name: string
  readonly integrationId: string
  readonly capabilities: readonly MqttHaCap[]
}

/** Meta passed to `devices.create` for one adopted plan. */
export function mqttHaInitialMeta(input: MqttHaInitialMetaInput): InitialDeviceMeta {
  const role = deviceRoleForCapabilities(input.deviceType, input.capabilities)
  return {
    type: input.deviceType,
    name: input.name,
    integrationId: input.integrationId,
    ...(role !== null ? { role } : {}),
  }
}

/** Role already stored on the device meta row. Null and absence are unset. */
export function persistedDeviceRole(meta: object): string | null {
  if (!('role' in meta)) return null
  const value: unknown = meta.role
  if (typeof value !== 'string' || value.length === 0) return null
  return value
}
