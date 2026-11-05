import { DeviceRole, type DeviceType, type InitialDeviceMeta } from '@camstack/types'
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
    case undefined:
      return null
  }
}

/** What one adopted plan contributes to the device meta row. */
export interface MqttHaInitialMetaInput {
  readonly deviceType: DeviceType
  readonly name: string
  readonly integrationId: string
  readonly primaryCap: MqttHaCap | undefined
}

/** Meta passed to `devices.create` for one adopted plan. */
export function mqttHaInitialMeta(input: MqttHaInitialMetaInput): InitialDeviceMeta {
  const role = deviceRoleForPrimaryCap(input.primaryCap)
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
