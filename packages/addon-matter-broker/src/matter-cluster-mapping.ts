import { DeviceType } from '@camstack/types'

/**
 * Pure mapping from a Matter endpoint's present cluster set to the CamStack typed
 * caps the accessory child registers. Unit-tested in isolation — NO matter.js
 * import here so the mapping stays a pure, total function over plain data.
 *
 * The plan's cluster → cap table (§2.3) drives this. Each endpoint is reduced to
 * the set of cluster ids it exposes (server clusters), and we union the caps each
 * recognised cluster contributes. Multi-cluster endpoints (e.g. a dimmable colour
 * bulb = OnOff + LevelControl + ColorControl) yield several caps on one child.
 */

/** The CamStack device-native caps a Matter endpoint can map onto (v1 subset). */
export type MatterEndpointCap =
  | 'switch'
  | 'brightness'
  | 'color'
  | 'lock-control'
  | 'climate-control'
  | 'cover'
  | 'temperature-sensor'
  | 'humidity-sensor'
  | 'pressure-sensor'
  | 'ambient-light-sensor'
  | 'contact'
  | 'motion'
  | 'battery'
  | 'power-meter'
  | 'button'

/**
 * Matter cluster ids relevant to the v1 device surface. Values are the official
 * Matter cluster ids (hex in the spec) expressed as decimal numbers so the
 * mapping needs no matter.js import. A persisted/probed endpoint carries the
 * numeric cluster ids it exposes; we map those to caps.
 */
export const MatterClusterId = {
  OnOff: 0x0006,
  LevelControl: 0x0008,
  ColorControl: 0x0300,
  DoorLock: 0x0101,
  Thermostat: 0x0201,
  WindowCovering: 0x0102,
  TemperatureMeasurement: 0x0402,
  RelativeHumidityMeasurement: 0x0405,
  PressureMeasurement: 0x0403,
  IlluminanceMeasurement: 0x0400,
  BooleanState: 0x0045,
  OccupancySensing: 0x0406,
  PowerSource: 0x002f,
  ElectricalPowerMeasurement: 0x0090,
  ElectricalEnergyMeasurement: 0x0091,
  Switch: 0x003b,
} as const

/** One cluster → the caps it contributes (most contribute exactly one). */
const CLUSTER_TO_CAPS: ReadonlyMap<number, readonly MatterEndpointCap[]> = new Map<
  number,
  readonly MatterEndpointCap[]
>([
  [MatterClusterId.OnOff, ['switch']],
  [MatterClusterId.LevelControl, ['brightness']],
  [MatterClusterId.ColorControl, ['color']],
  [MatterClusterId.DoorLock, ['lock-control']],
  [MatterClusterId.Thermostat, ['climate-control']],
  [MatterClusterId.WindowCovering, ['cover']],
  [MatterClusterId.TemperatureMeasurement, ['temperature-sensor']],
  [MatterClusterId.RelativeHumidityMeasurement, ['humidity-sensor']],
  [MatterClusterId.PressureMeasurement, ['pressure-sensor']],
  [MatterClusterId.IlluminanceMeasurement, ['ambient-light-sensor']],
  [MatterClusterId.BooleanState, ['contact']],
  [MatterClusterId.OccupancySensing, ['motion']],
  [MatterClusterId.PowerSource, ['battery']],
  [MatterClusterId.ElectricalPowerMeasurement, ['power-meter']],
  [MatterClusterId.ElectricalEnergyMeasurement, ['power-meter']],
  [MatterClusterId.Switch, ['button']],
])

/** Stable cap order so a derived child's cap list is deterministic. */
const CAP_ORDER: readonly MatterEndpointCap[] = [
  'switch',
  'brightness',
  'color',
  'lock-control',
  'climate-control',
  'cover',
  'temperature-sensor',
  'humidity-sensor',
  'pressure-sensor',
  'ambient-light-sensor',
  'contact',
  'motion',
  'power-meter',
  'button',
  'battery',
]

export interface MatterEndpointMapping {
  /** The CamStack device type the endpoint materialises as. */
  readonly deviceType: DeviceType
  /** The caps the endpoint child registers (deterministic order). */
  readonly capabilities: readonly MatterEndpointCap[]
}

/**
 * Reduce an endpoint's present cluster ids to its CamStack device type + caps.
 * Pure + total: an endpoint with no recognised cluster maps to a Generic device
 * with no caps (the adoption layer skips empty endpoints).
 */
export function mapMatterEndpointToCamStack(
  presentClusterIds: readonly number[],
): MatterEndpointMapping {
  const caps = new Set<MatterEndpointCap>()
  for (const id of presentClusterIds) {
    const contributed = CLUSTER_TO_CAPS.get(id)
    if (contributed === undefined) continue
    for (const cap of contributed) caps.add(cap)
  }
  const ordered = CAP_ORDER.filter((c) => caps.has(c))
  return {
    deviceType: deviceTypeForCaps(ordered),
    capabilities: ordered,
  }
}

/** Pick the most-specific CamStack device type for a cap set. */
function deviceTypeForCaps(caps: readonly MatterEndpointCap[]): DeviceType {
  if (caps.includes('lock-control')) return DeviceType.Lock
  if (caps.includes('cover')) return DeviceType.Cover
  if (caps.includes('climate-control')) return DeviceType.Thermostat
  if (caps.includes('color') || caps.includes('brightness')) return DeviceType.Light
  if (caps.includes('switch')) return DeviceType.Switch
  if (caps.includes('button')) return DeviceType.Button
  if (
    caps.includes('temperature-sensor') ||
    caps.includes('humidity-sensor') ||
    caps.includes('pressure-sensor') ||
    caps.includes('ambient-light-sensor') ||
    caps.includes('contact') ||
    caps.includes('motion')
  ) {
    return DeviceType.Sensor
  }
  return DeviceType.Generic
}

/** Human label for an endpoint from its index + mapped device type. */
export function endpointLabel(endpointId: number, deviceType: DeviceType): string {
  const base = ENDPOINT_TYPE_LABEL[deviceType] ?? 'Endpoint'
  return endpointId === 0 ? base : `${base} #${endpointId}`
}

const ENDPOINT_TYPE_LABEL: Partial<Record<DeviceType, string>> = {
  [DeviceType.Light]: 'Light',
  [DeviceType.Switch]: 'Switch',
  [DeviceType.Lock]: 'Lock',
  [DeviceType.Cover]: 'Cover',
  [DeviceType.Thermostat]: 'Thermostat',
  [DeviceType.Sensor]: 'Sensor',
  [DeviceType.Button]: 'Button',
  [DeviceType.Generic]: 'Endpoint',
}
