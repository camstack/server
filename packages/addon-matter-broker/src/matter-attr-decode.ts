/**
 * Pure Matter attribute-report decoder. Maps a single
 * `(clusterId, attributeId, value)` report onto a partial CamStack cap slice
 * (`{ cap, patch }`), or `null` when the attribute carries no cap-relevant
 * value. NO matter.js import — operates on plain decoded numbers/booleans so it
 * stays a pure, unit-testable function (mirrors `matter-cluster-mapping.ts`).
 *
 * The controller (`matter-controller-impl.ts`) reads each endpoint's behavior
 * state from matter.js and emits one {@link import('./matter-controller.js').MatterAttributeReport}
 * per named attribute, carrying the canonical Matter `attributeId`. The endpoint
 * device class runs this decoder per report and patches the cap's runtime-state
 * slice with the result.
 *
 * Matter encodes most physical quantities as scaled integers; the per-cluster
 * cases below apply the spec scaling (e.g. TemperatureMeasurement `measuredValue`
 * is hundredths of a degree Celsius; ElectricalPowerMeasurement `activePower` is
 * milliwatts). Cluster ids reuse {@link MatterClusterId}; attribute ids are the
 * Matter spec attribute ids for the decoded attribute.
 */

import { MatterClusterId, type MatterEndpointCap } from './matter-cluster-mapping.js'

/** Canonical Matter attribute ids the decoder recognises (per cluster). */
export const MatterAttributeId = {
  /** OnOff.OnOff (bool). */
  OnOff: 0x0000,
  /** LevelControl.CurrentLevel (uint8, 0..254). */
  CurrentLevel: 0x0000,
  /** BooleanState.StateValue (bool). */
  StateValue: 0x0000,
  /** OccupancySensing.Occupancy (bitmap, bit0 = occupied). */
  Occupancy: 0x0000,
  /** *Measurement.MeasuredValue (scaled int per cluster). */
  MeasuredValue: 0x0000,
  /** Global attribute: the cluster FeatureMap (bitmap). PowerSource: bit0 Wired, bit1 Battery. */
  FeatureMap: 0xfffc,
  /** PowerSource.BatPercentRemaining (uint8, half-percent 0..200). */
  BatPercentRemaining: 0x000c,
  /** PowerSource.BatChargeLevel (enum: 0=Ok,1=Warning,2=Critical). Some locks report only this. */
  BatChargeLevel: 0x000e,
  /** PowerSource.BatChargeState (enum: 0=Unknown,1=IsCharging,2=IsAtFullCharge,3=IsNotCharging). */
  BatChargeState: 0x001a,
  /** SmokeCoAlarm.SmokeState (AlarmState: 0 Normal, 1 Warning, 2 Critical). */
  SmokeState: 0x0001,
  /** SmokeCoAlarm.COState (AlarmState). */
  CoState: 0x0002,
  /** ValveConfigurationAndControl.CurrentState (0 Closed, 1 Open, 2 Transitioning). */
  ValveCurrentState: 0x0004,
  /** ValveConfigurationAndControl.CurrentLevel (percent 0..100). */
  ValveCurrentLevel: 0x0006,
  /** Thermostat.LocalTemperature (int16, 0.01 °C). */
  LocalTemperature: 0x0000,
  /** Thermostat.OccupiedCoolingSetpoint (int16, 0.01 °C). */
  OccupiedCoolingSetpoint: 0x0011,
  /** Thermostat.OccupiedHeatingSetpoint (int16, 0.01 °C). */
  OccupiedHeatingSetpoint: 0x0012,
  /** Thermostat.SystemMode (enum). */
  SystemMode: 0x001c,
  /** ElectricalPowerMeasurement.Voltage (int64, mV). */
  Voltage: 0x0004,
  /** ElectricalPowerMeasurement.ActiveCurrent (int64, mA). */
  ActiveCurrent: 0x0005,
  /** ElectricalPowerMeasurement.ActivePower (int64, mW). */
  ActivePower: 0x0008,
  /** ElectricalEnergyMeasurement.CumulativeEnergyImported (energy struct, mWh). */
  CumulativeEnergyImported: 0x0001,
  /** DoorLock.LockState (enum: 0 NotFullyLocked, 1 Locked, 2 Unlocked, 3 Unlatched). */
  LockState: 0x0000,
  /** DoorLock.DoorState (enum; 2 = DoorJammed). Present only with the door sensor. */
  DoorState: 0x0003,
  /** DoorLock.RequirePinForRemoteOperation (bool). */
  RequirePinForRemoteOperation: 0x0033,
} as const

/** A decoded slice patch destined for one cap's runtime state. */
export interface DecodedAttribute {
  /** The cap whose runtime-state slice receives the patch. */
  readonly cap: MatterEndpointCap
  /**
   * The partial slice to merge into the cap's runtime state. Empty when the
   * report is a fact the cap schema cannot store (door open, PIN required) —
   * callers must not invent a lock state from an empty patch.
   */
  readonly patch: Record<string, unknown>
  /**
   * Matter-specific fact that is more precise than the cap enum. Logged, not
   * written into the slice. `not-fully-locked` is LockState 0 (the cap's
   * closest state is `jammed`). Door states keep the `door-` prefix.
   */
  readonly detail?: string
}

/** Thermostat.SystemMode enum → CamStack HvacMode (climate-control). */
const SYSTEM_MODE_TO_HVAC: ReadonlyMap<number, string> = new Map<number, string>([
  [0, 'off'],
  [1, 'auto'],
  [3, 'cool'],
  [4, 'heat'],
  [5, 'auto'], // EmergencyHeat → closest CamStack mode
  [7, 'fan_only'],
  [8, 'dry'],
])

/** Safely coerce an unknown report value to a finite number, else null. */
function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** Coerce an unknown report value to a boolean (Matter bool / 0|1), else null. */
function asBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  const n = asNumber(value)
  if (n === null) return null
  return n !== 0
}

/**
 * matter.js may surface a `MeasuredValue` either as a plain scaled int or wrapped
 * in an energy-measurement struct (`{ energy }`). Pull the numeric payload out.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asEnergyMilliWattHours(value: unknown): number | null {
  if (isRecord(value) && 'energy' in value) return asNumber(value['energy'])
  return asNumber(value)
}

/**
 * Decode one attribute report into a cap slice patch, or `null` when the
 * attribute is irrelevant / unparseable. Pure + total.
 */
export function decodeMatterAttribute(input: {
  readonly clusterId: number
  readonly attributeId: number
  readonly value: unknown
  /**
   * The cap BooleanState feeds on THIS endpoint. A contact sensor reads
   * `true` = closed; a water-leak or rain detector reads `true` = detected.
   * The endpoint knows which one it is (Descriptor device type); the cluster
   * alone does not.
   */
  readonly booleanState?: 'contact' | 'flood'
  /** Ms epoch stamped on every timestamp the patch carries; default now (live), a replay passes the recorded time. */
  readonly at?: number
}): DecodedAttribute | null {
  const { clusterId, attributeId, value } = input
  const at = input.at ?? Date.now()
  switch (clusterId) {
    case MatterClusterId.OnOff:
      return decodeOnOff(attributeId, value, at)
    case MatterClusterId.LevelControl:
      return decodeLevel(attributeId, value, at)
    case MatterClusterId.BooleanState:
      return input.booleanState === 'flood'
        ? decodeFlood(attributeId, value, at)
        : decodeContact(attributeId, value, at)
    case MatterClusterId.OccupancySensing:
      return decodeOccupancy(attributeId, value, at)
    case MatterClusterId.TemperatureMeasurement:
      return decodeScaledMeasurement(
        attributeId,
        value,
        'temperature-sensor',
        'temperature',
        0.01,
        at,
      )
    case MatterClusterId.RelativeHumidityMeasurement:
      return decodeScaledMeasurement(attributeId, value, 'humidity-sensor', 'humidity', 0.01, at)
    case MatterClusterId.PressureMeasurement:
      // PressureMeasurement.MeasuredValue is in kPa×10; 1 kPa = 10 hPa → ×1.
      return decodeScaledMeasurement(attributeId, value, 'pressure-sensor', 'pressure', 1, at)
    case MatterClusterId.IlluminanceMeasurement:
      return decodeIlluminance(attributeId, value, at)
    case MatterClusterId.PowerSource:
      return decodeBattery(attributeId, value, at)
    case MatterClusterId.Thermostat:
      return decodeThermostat(attributeId, value, at)
    case MatterClusterId.ElectricalPowerMeasurement:
      return decodeElectricalPower(attributeId, value, at)
    case MatterClusterId.ElectricalEnergyMeasurement:
      return decodeElectricalEnergy(attributeId, value, at)
    case MatterClusterId.DoorLock:
      return decodeDoorLock(attributeId, value, at)
    case MatterClusterId.SmokeCoAlarm:
      return decodeSmokeCoAlarm(attributeId, value, at)
    case MatterClusterId.ValveConfigurationAndControl:
      return decodeValve(attributeId, value, at)
    case MatterClusterId.CarbonDioxideConcentration:
      return decodeConcentration(attributeId, value, 'co2', at)
    case MatterClusterId.Pm25Concentration:
      return decodeConcentration(attributeId, value, 'pm25', at)
    case MatterClusterId.Pm10Concentration:
      return decodeConcentration(attributeId, value, 'pm10', at)
    case MatterClusterId.TvocConcentration:
      return decodeConcentration(attributeId, value, 'voc', at)
    default:
      return null
  }
}

/** LockState enum → cap state. NotFullyLocked has no cap value of its own. */
const LOCK_STATE_TO_CAP: ReadonlyMap<number, { readonly state: string; readonly detail?: string }> =
  new Map([
    [0, { state: 'jammed', detail: 'not-fully-locked' }],
    [1, { state: 'locked' }],
    [2, { state: 'unlocked' }],
    [3, { state: 'unlocked', detail: 'unlatched' }],
  ])

/** DoorState enum → a detail. Only DoorJammed also moves the lock cap. */
const DOOR_STATE_DETAIL: ReadonlyMap<number, string> = new Map([
  [0, 'door-open'],
  [1, 'door-closed'],
  [2, 'door-jammed'],
  [3, 'door-forced-open'],
  [4, 'door-unspecified'],
  [5, 'door-ajar'],
])

/** DoorState → is the door open. Unspecified (4) says nothing about the door. */
const DOOR_STATE_OPEN: ReadonlyMap<number, boolean> = new Map([
  [0, true],
  [1, false],
  [3, true],
  [5, true],
])

function decodeDoorLock(attributeId: number, value: unknown, at: number): DecodedAttribute | null {
  if (attributeId === MatterAttributeId.LockState) {
    const raw = asNumber(value)
    if (raw === null) return null
    const mapped = LOCK_STATE_TO_CAP.get(raw)
    if (mapped === undefined) return null
    const decoded: DecodedAttribute = {
      cap: 'lock-control',
      patch: { state: mapped.state, lastChangedAt: at },
      ...(mapped.detail !== undefined ? { detail: mapped.detail } : {}),
    }
    return decoded
  }
  if (attributeId === MatterAttributeId.DoorState) {
    const raw = asNumber(value)
    if (raw === null) return null
    const detail = DOOR_STATE_DETAIL.get(raw)
    if (detail === undefined) return null
    if (detail === 'door-jammed') {
      return {
        cap: 'lock-control',
        patch: { state: 'jammed', lastChangedAt: at },
        detail,
      }
    }
    // The door sensor is a fact of its own: it feeds the door-contact the
    // lock exposes. DoorJammed is the BOLT failing, not the door position.
    const open = DOOR_STATE_OPEN.get(raw)
    if (open !== undefined) {
      return { cap: 'contact', patch: { entryOpen: open, lastChangedAt: at }, detail }
    }
    return { cap: 'lock-control', patch: {}, detail }
  }
  if (attributeId === MatterAttributeId.RequirePinForRemoteOperation) {
    const required = asBoolean(value)
    if (required === null) return null
    // The lock slice's `codeRequired` (#459); a missing report stays unknown.
    return {
      cap: 'lock-control',
      patch: { codeRequired: required },
      detail: required ? 'pin-required' : 'pin-not-required',
    }
  }
  return null
}

function decodeFlood(attributeId: number, value: unknown, at: number): DecodedAttribute | null {
  if (attributeId !== MatterAttributeId.StateValue) return null
  const detected = asBoolean(value)
  if (detected === null) return null
  // Water-leak / rain detector: StateValue true = detected (not "closed").
  return { cap: 'flood', patch: { flooded: detected, lastChangedAt: at } }
}

/** SmokeCOAlarm AlarmState: anything but Normal(0) is an alarm. */
function decodeSmokeCoAlarm(
  attributeId: number,
  value: unknown,
  at: number,
): DecodedAttribute | null {
  const raw = asNumber(value)
  if (raw === null) return null
  const detected = raw !== 0
  if (attributeId === MatterAttributeId.SmokeState) {
    return { cap: 'smoke', patch: { detected, lastChangedAt: at } }
  }
  if (attributeId === MatterAttributeId.CoState) {
    return { cap: 'carbon-monoxide', patch: { detected, lastChangedAt: at } }
  }
  return null
}

function decodeValve(attributeId: number, value: unknown, at: number): DecodedAttribute | null {
  const raw = asNumber(value)
  if (raw === null) return null
  if (attributeId === MatterAttributeId.ValveCurrentState) {
    // 2 = Transitioning says "moving", not which way: the command that started
    // the move already recorded opening / closing, so leave the slice alone.
    if (raw === 0) return { cap: 'valve', patch: { state: 'closed', lastChangedAt: at } }
    if (raw === 1) return { cap: 'valve', patch: { state: 'open', lastChangedAt: at } }
    return { cap: 'valve', patch: {}, detail: 'valve-transitioning' }
  }
  if (attributeId === MatterAttributeId.ValveCurrentLevel) {
    const position = Math.max(0, Math.min(100, raw))
    return { cap: 'valve', patch: { position, lastChangedAt: at } }
  }
  return null
}

/**
 * Concentration clusters (CO2, PM2.5, PM10, TVOC): MeasuredValue is a float in
 * the cluster's MeasurementUnit. The defaults the cap documents (ppm, µg/m³,
 * ppb) are assumed; null/NaN is "not measured" and is no value (D393).
 */
function decodeConcentration(
  attributeId: number,
  value: unknown,
  field: 'co2' | 'pm25' | 'pm10' | 'voc',
  at: number,
): DecodedAttribute | null {
  if (attributeId !== MatterAttributeId.MeasuredValue) return null
  const raw = asNumber(value)
  if (raw === null || raw < 0) return null
  return { cap: 'air-quality-sensor', patch: { [field]: raw, lastFetchedAt: at } }
}

function decodeOnOff(attributeId: number, value: unknown, at: number): DecodedAttribute | null {
  if (attributeId !== MatterAttributeId.OnOff) return null
  const on = asBoolean(value)
  return on === null ? null : { cap: 'switch', patch: { on, lastChangedAt: at } }
}

function decodeLevel(attributeId: number, value: unknown, at: number): DecodedAttribute | null {
  if (attributeId !== MatterAttributeId.CurrentLevel) return null
  const level = asNumber(value)
  if (level === null) return null
  // Matter LevelControl.CurrentLevel is 0..254 → CamStack percentage 0..100.
  const percentage = Math.round((Math.max(0, Math.min(254, level)) / 254) * 100)
  return { cap: 'brightness', patch: { level: percentage, lastChangedAt: at } }
}

function decodeContact(attributeId: number, value: unknown, at: number): DecodedAttribute | null {
  if (attributeId !== MatterAttributeId.StateValue) return null
  const stateValue = asBoolean(value)
  if (stateValue === null) return null
  // BooleanState.StateValue true = contact closed; CamStack `entryOpen` is the
  // inverse (an open entry/door). A contact sensor reporting "closed" ⇒ not open.
  return { cap: 'contact', patch: { entryOpen: !stateValue, lastChangedAt: at } }
}

function decodeOccupancy(attributeId: number, value: unknown, at: number): DecodedAttribute | null {
  if (attributeId !== MatterAttributeId.Occupancy) return null
  const bitmap = asNumber(value)
  if (bitmap === null) return null
  const detected = (bitmap & 0x1) !== 0
  // `lastDetectedAt` is the LAST RISE and survives the fall: `null` means
  // "never detected" (`motion.cap.ts`). A clear therefore patches the level
  // only, and the merge keeps the stamp of the rise before it.
  return {
    cap: 'motion',
    patch: detected ? { detected, lastDetectedAt: at } : { detected },
  }
}

function decodeScaledMeasurement(
  attributeId: number,
  value: unknown,
  cap: MatterEndpointCap,
  field: string,
  scale: number,
  at: number,
): DecodedAttribute | null {
  if (attributeId !== MatterAttributeId.MeasuredValue) return null
  const raw = asNumber(value)
  // Matter uses a sentinel (null / 0x8000) for "unknown"; treat null as no value.
  if (raw === null) return null
  return { cap, patch: { [field]: raw * scale, lastFetchedAt: at } }
}

function decodeIlluminance(
  attributeId: number,
  value: unknown,
  at: number,
): DecodedAttribute | null {
  if (attributeId !== MatterAttributeId.MeasuredValue) return null
  const raw = asNumber(value)
  if (raw === null || raw <= 0) return null
  // IlluminanceMeasurement.MeasuredValue = 10000 × log10(lux) + 1 ⇒ invert.
  const lux = Math.round(10 ** ((raw - 1) / 10000))
  return { cap: 'ambient-light-sensor', patch: { illuminance: lux, lastFetchedAt: at } }
}

function decodeBattery(attributeId: number, value: unknown, at: number): DecodedAttribute | null {
  if (attributeId === MatterAttributeId.BatPercentRemaining) {
    const half = asNumber(value)
    if (half === null) return null
    // PowerSource.BatPercentRemaining is in half-percent (0..200) → 0..100.
    const percentage = Math.max(0, Math.min(100, Math.round(half / 2)))
    return {
      cap: 'battery',
      patch: { level: percentage, binary: false, lastUpdated: at },
      detail: 'battery-percent',
    }
  }
  if (attributeId === MatterAttributeId.BatChargeLevel) {
    const level = asNumber(value)
    if (level === null) return null
    // Locks that publish only the level enum: 0 Ok, 1 Warning, 2 Critical. It is
    // a coarse stand-in (`binary`), so a real percentage always wins over it.
    const stand = BAT_CHARGE_LEVEL_STAND_IN.get(level)
    if (stand === undefined) return null
    return {
      cap: 'battery',
      patch: { level: stand, binary: true, lastUpdated: at },
      detail: 'battery-level-only',
    }
  }
  if (attributeId === MatterAttributeId.BatChargeState) {
    const state = asNumber(value)
    if (state === null) return null
    // 0 Unknown, 1 IsCharging, 2 IsAtFullCharge (still on a charger), 3 IsNotCharging.
    const charging = state === 1 || state === 2 ? 'dc' : state === 3 ? 'none' : 'unknown'
    return { cap: 'battery', patch: { charging, lastUpdated: at } }
  }
  return null
}

/** BatChargeLevel enum → coarse percentage (the UI shows Normal / Low for `binary`). */
const BAT_CHARGE_LEVEL_STAND_IN: ReadonlyMap<number, number> = new Map([
  [0, 100],
  [1, 20],
  [2, 5],
])

function decodeThermostat(
  attributeId: number,
  value: unknown,
  at: number,
): DecodedAttribute | null {
  switch (attributeId) {
    case MatterAttributeId.LocalTemperature: {
      const raw = asNumber(value)
      return raw === null
        ? null
        : { cap: 'climate-control', patch: { currentTemp: raw * 0.01, lastFetchedAt: at } }
    }
    case MatterAttributeId.OccupiedHeatingSetpoint:
    case MatterAttributeId.OccupiedCoolingSetpoint: {
      const raw = asNumber(value)
      return raw === null
        ? null
        : { cap: 'climate-control', patch: { target: raw * 0.01, lastFetchedAt: at } }
    }
    case MatterAttributeId.SystemMode: {
      const raw = asNumber(value)
      if (raw === null) return null
      const mode = SYSTEM_MODE_TO_HVAC.get(raw)
      return mode === undefined
        ? null
        : { cap: 'climate-control', patch: { mode, lastFetchedAt: at } }
    }
    default:
      return null
  }
}

function decodeElectricalPower(
  attributeId: number,
  value: unknown,
  at: number,
): DecodedAttribute | null {
  switch (attributeId) {
    case MatterAttributeId.ActivePower: {
      const mw = asNumber(value)
      return mw === null
        ? null
        : { cap: 'power-meter', patch: { power: mw / 1000, lastFetchedAt: at } }
    }
    case MatterAttributeId.Voltage: {
      const mv = asNumber(value)
      return mv === null
        ? null
        : { cap: 'power-meter', patch: { voltage: mv / 1000, lastFetchedAt: at } }
    }
    case MatterAttributeId.ActiveCurrent: {
      const ma = asNumber(value)
      return ma === null
        ? null
        : { cap: 'power-meter', patch: { current: ma / 1000, lastFetchedAt: at } }
    }
    default:
      return null
  }
}

function decodeElectricalEnergy(
  attributeId: number,
  value: unknown,
  at: number,
): DecodedAttribute | null {
  if (attributeId !== MatterAttributeId.CumulativeEnergyImported) return null
  const mwh = asEnergyMilliWattHours(value)
  if (mwh === null) return null
  // mWh → kWh (÷ 1e6).
  return { cap: 'power-meter', patch: { energy: mwh / 1_000_000, lastFetchedAt: at } }
}

/** What a PowerSource cluster says the node is powered by. */
export type PowerSourceKind = 'wired' | 'battery'

/** PowerSource FeatureMap bit0: the source is wired (mains). */
const POWER_SOURCE_WIRED_BIT = 0x1
/** PowerSource FeatureMap bit1: the source is a battery. */
const POWER_SOURCE_BATTERY_BIT = 0x2

/**
 * What one PowerSource cluster is, from its FeatureMap: a number / bigint bitmap
 * or a named-feature record (`{ wired, battery }`, matter.js's decoded form).
 * `null` = the map was not readable, or names neither feature: unknown, never a
 * guess. A source carrying both bits is a wired source with a battery behind it;
 * the node is mains-powered, so `wired` wins.
 */
export function decodePowerSourceKind(featureMap: unknown): PowerSourceKind | null {
  let wired: boolean | null = null
  let battery: boolean | null = null
  if (typeof featureMap === 'number' || typeof featureMap === 'bigint') {
    const bits = Number(featureMap)
    wired = (bits & POWER_SOURCE_WIRED_BIT) !== 0
    battery = (bits & POWER_SOURCE_BATTERY_BIT) !== 0
  } else if (typeof featureMap === 'object' && featureMap !== null) {
    const named = (key: string): boolean | null => {
      const v: unknown = Reflect.get(featureMap, key)
      return typeof v === 'boolean' ? v : null
    }
    wired = named('wired')
    battery = named('battery')
  }
  if (wired === true) return 'wired'
  if (battery === true) return 'battery'
  return null
}
