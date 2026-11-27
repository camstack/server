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
  | 'flood'
  | 'smoke'
  | 'carbon-monoxide'
  | 'air-quality-sensor'
  | 'valve'
  | 'event-emitter'

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
  BasicInformation: 0x0028,
  GeneralDiagnostics: 0x0033,
  ThreadNetworkDiagnostics: 0x0035,
  WiFiNetworkDiagnostics: 0x0036,
  EthernetNetworkDiagnostics: 0x0037,
  OperationalCredentials: 0x003e,
  ElectricalPowerMeasurement: 0x0090,
  ElectricalEnergyMeasurement: 0x0091,
  Switch: 0x003b,
  SmokeCoAlarm: 0x005c,
  ValveConfigurationAndControl: 0x0081,
  CarbonDioxideConcentration: 0x040d,
  Pm25Concentration: 0x042a,
  Pm10Concentration: 0x042d,
  TvocConcentration: 0x042e,
} as const

/**
 * Descriptor device type ids that change what a shared cluster MEANS. The
 * Descriptor `deviceTypeList` is the only thing that tells a water-leak
 * detector from a door contact (both are BooleanState), or a smart plug from a
 * dimmable light (both are OnOff + LevelControl).
 */
export const MatterDeviceTypeId = {
  DoorLock: 0x000a,
  ContactSensor: 0x0015,
  OnOffPlugInUnit: 0x010a,
  DimmablePlugInUnit: 0x010b,
  WaterFreezeDetector: 0x0041,
  WaterValve: 0x0042,
  WaterLeakDetector: 0x0043,
  RainSensor: 0x0044,
  SmokeCoAlarm: 0x0076,
} as const

/** BooleanState endpoints whose `true` means "detected", not "closed". */
const LEAK_DEVICE_TYPES: ReadonlySet<number> = new Set([
  MatterDeviceTypeId.WaterFreezeDetector,
  MatterDeviceTypeId.WaterLeakDetector,
  MatterDeviceTypeId.RainSensor,
])

/** Plug device types: OnOff (+ Level) there is a socket, not a light. */
const PLUG_DEVICE_TYPES: ReadonlySet<number> = new Set([
  MatterDeviceTypeId.OnOffPlugInUnit,
  MatterDeviceTypeId.DimmablePlugInUnit,
])

/** What the controller read off the endpoint besides its cluster ids. */
export interface MatterEndpointHints {
  /** Descriptor `deviceTypeList` ids. Absent / empty → decided by clusters alone. */
  readonly deviceTypeIds?: readonly number[]
  /** `"clusterId:attributeId"` of the recognised attributes the endpoint carries. */
  readonly attributes?: readonly string[]
}

/** Optional DoorLock attribute: only locks with a door sensor have it. */
const DOOR_STATE_KEY = `${MatterClusterId.DoorLock}:3`
/** SmokeCOAlarm attributes, present per feature (a smoke-only unit has no COState). */
const SMOKE_STATE_KEY = `${MatterClusterId.SmokeCoAlarm}:1`
const CO_STATE_KEY = `${MatterClusterId.SmokeCoAlarm}:2`

/** True when the endpoint is a leak / rain / freeze detector by its Descriptor. */
export function isLeakEndpoint(hints: MatterEndpointHints | undefined): boolean {
  return (hints?.deviceTypeIds ?? []).some((id) => LEAK_DEVICE_TYPES.has(id))
}

/** One cluster → the caps it contributes (most contribute exactly one). */
const CLUSTER_TO_CAPS: ReadonlyMap<number, readonly MatterEndpointCap[]> = new Map<
  number,
  readonly MatterEndpointCap[]
>([
  [MatterClusterId.OnOff, ['switch']],
  [MatterClusterId.LevelControl, ['brightness']],
  [MatterClusterId.ColorControl, ['color']],
  [MatterClusterId.DoorLock, ['lock-control', 'event-emitter']],
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
  [MatterClusterId.Switch, ['button', 'event-emitter']],
  [MatterClusterId.ValveConfigurationAndControl, ['valve']],
  [MatterClusterId.CarbonDioxideConcentration, ['air-quality-sensor']],
  [MatterClusterId.Pm25Concentration, ['air-quality-sensor']],
  [MatterClusterId.Pm10Concentration, ['air-quality-sensor']],
  [MatterClusterId.TvocConcentration, ['air-quality-sensor']],
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
  'flood',
  'smoke',
  'carbon-monoxide',
  'air-quality-sensor',
  'motion',
  'valve',
  'power-meter',
  'button',
  'event-emitter',
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
  hints?: MatterEndpointHints,
): MatterEndpointMapping {
  const caps = new Set<MatterEndpointCap>()
  const attributes = new Set(hints?.attributes ?? [])
  for (const id of presentClusterIds) {
    for (const cap of capsForCluster(id, hints, attributes)) caps.add(cap)
  }
  const ordered = CAP_ORDER.filter((c) => caps.has(c))
  return {
    deviceType: deviceTypeForCaps(ordered, hints),
    capabilities: ordered,
  }
}

/** The caps one cluster contributes on THIS endpoint (hints refine the shared ones). */
function capsForCluster(
  clusterId: number,
  hints: MatterEndpointHints | undefined,
  attributes: ReadonlySet<string>,
): readonly MatterEndpointCap[] {
  switch (clusterId) {
    case MatterClusterId.BooleanState:
      return isLeakEndpoint(hints) ? ['flood'] : ['contact']
    case MatterClusterId.DoorLock:
      // The door sensor is optional hardware: without DoorState there is no
      // door position to report, and a made-up "closed" would be a false fact.
      return attributes.has(DOOR_STATE_KEY)
        ? ['lock-control', 'event-emitter', 'contact']
        : ['lock-control', 'event-emitter']
    case MatterClusterId.SmokeCoAlarm: {
      const out: MatterEndpointCap[] = []
      if (attributes.has(SMOKE_STATE_KEY) || !attributes.has(CO_STATE_KEY)) out.push('smoke')
      if (attributes.has(CO_STATE_KEY)) out.push('carbon-monoxide')
      return out
    }
    default:
      return CLUSTER_TO_CAPS.get(clusterId) ?? []
  }
}

/** Pick the most-specific CamStack device type for a cap set. */
function deviceTypeForCaps(
  caps: readonly MatterEndpointCap[],
  hints: MatterEndpointHints | undefined,
): DeviceType {
  if (caps.includes('lock-control')) return DeviceType.Lock
  if (caps.includes('cover')) return DeviceType.Cover
  if (caps.includes('valve')) return DeviceType.Valve
  // D1033: a thermostat is a `climate` device; its role is the operator's to set.
  if (caps.includes('climate-control')) return DeviceType.Climate
  // A dimmable plug is a socket that happens to dim, not a lamp (Descriptor).
  const plug = (hints?.deviceTypeIds ?? []).some((id) => PLUG_DEVICE_TYPES.has(id))
  if (plug && caps.includes('switch')) return DeviceType.Switch
  if (caps.includes('color') || caps.includes('brightness')) return DeviceType.Light
  if (caps.includes('switch')) return DeviceType.Switch
  if (caps.includes('button')) return DeviceType.Button
  if (
    caps.includes('temperature-sensor') ||
    caps.includes('humidity-sensor') ||
    caps.includes('pressure-sensor') ||
    caps.includes('ambient-light-sensor') ||
    caps.includes('contact') ||
    caps.includes('flood') ||
    caps.includes('smoke') ||
    caps.includes('carbon-monoxide') ||
    caps.includes('air-quality-sensor') ||
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
  [DeviceType.Climate]: 'Thermostat',
  [DeviceType.Sensor]: 'Sensor',
  [DeviceType.Valve]: 'Valve',
  [DeviceType.Button]: 'Button',
  [DeviceType.Generic]: 'Endpoint',
}
