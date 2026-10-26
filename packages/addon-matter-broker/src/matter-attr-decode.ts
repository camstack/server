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
  /** PowerSource.BatPercentRemaining (uint8, half-percent 0..200). */
  BatPercentRemaining: 0x000c,
  /** PowerSource.BatChargeState (enum: 0=Unknown,1=IsCharging,2=IsAtFullCharge,3=IsNotCharging). */
  BatChargeState: 0x0010,
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
} as const

/** A decoded slice patch destined for one cap's runtime state. */
export interface DecodedAttribute {
  /** The cap whose runtime-state slice receives the patch. */
  readonly cap: MatterEndpointCap
  /** The partial slice to merge into the cap's runtime state. */
  readonly patch: Record<string, unknown>
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
function asEnergyMilliWattHours(value: unknown): number | null {
  if (typeof value === 'object' && value !== null && 'energy' in value) {
    return asNumber((value as { energy: unknown }).energy)
  }
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
}): DecodedAttribute | null {
  const { clusterId, attributeId, value } = input
  switch (clusterId) {
    case MatterClusterId.OnOff:
      return decodeOnOff(attributeId, value)
    case MatterClusterId.LevelControl:
      return decodeLevel(attributeId, value)
    case MatterClusterId.BooleanState:
      return decodeContact(attributeId, value)
    case MatterClusterId.OccupancySensing:
      return decodeOccupancy(attributeId, value)
    case MatterClusterId.TemperatureMeasurement:
      return decodeScaledMeasurement(attributeId, value, 'temperature-sensor', 'celsius', 0.01)
    case MatterClusterId.RelativeHumidityMeasurement:
      return decodeScaledMeasurement(attributeId, value, 'humidity-sensor', 'percent', 0.01)
    case MatterClusterId.PressureMeasurement:
      // PressureMeasurement.MeasuredValue is in kPa×10; 1 kPa = 10 hPa → ×1.
      return decodeScaledMeasurement(attributeId, value, 'pressure-sensor', 'hpa', 1)
    case MatterClusterId.IlluminanceMeasurement:
      return decodeIlluminance(attributeId, value)
    case MatterClusterId.PowerSource:
      return decodeBattery(attributeId, value)
    case MatterClusterId.Thermostat:
      return decodeThermostat(attributeId, value)
    case MatterClusterId.ElectricalPowerMeasurement:
      return decodeElectricalPower(attributeId, value)
    case MatterClusterId.ElectricalEnergyMeasurement:
      return decodeElectricalEnergy(attributeId, value)
    default:
      return null
  }
}

function decodeOnOff(attributeId: number, value: unknown): DecodedAttribute | null {
  if (attributeId !== MatterAttributeId.OnOff) return null
  const on = asBoolean(value)
  return on === null ? null : { cap: 'switch', patch: { on, lastChangedAt: Date.now() } }
}

function decodeLevel(attributeId: number, value: unknown): DecodedAttribute | null {
  if (attributeId !== MatterAttributeId.CurrentLevel) return null
  const level = asNumber(value)
  if (level === null) return null
  // Matter LevelControl.CurrentLevel is 0..254 → CamStack percentage 0..100.
  const percentage = Math.round((Math.max(0, Math.min(254, level)) / 254) * 100)
  return { cap: 'brightness', patch: { percentage, lastChangedAt: Date.now() } }
}

function decodeContact(attributeId: number, value: unknown): DecodedAttribute | null {
  if (attributeId !== MatterAttributeId.StateValue) return null
  const stateValue = asBoolean(value)
  if (stateValue === null) return null
  // BooleanState.StateValue true = contact closed; CamStack `entryOpen` is the
  // inverse (an open entry/door). A contact sensor reporting "closed" ⇒ not open.
  return { cap: 'contact', patch: { entryOpen: !stateValue, lastChangedAt: Date.now() } }
}

function decodeOccupancy(attributeId: number, value: unknown): DecodedAttribute | null {
  if (attributeId !== MatterAttributeId.Occupancy) return null
  const bitmap = asNumber(value)
  if (bitmap === null) return null
  const detected = (bitmap & 0x1) !== 0
  // `lastDetectedAt` is the LAST RISE and survives the fall: `null` means
  // "never detected" (`motion.cap.ts`). A clear therefore patches the level
  // only, and the merge keeps the stamp of the rise before it.
  return {
    cap: 'motion',
    patch: detected ? { detected, lastDetectedAt: Date.now() } : { detected },
  }
}

function decodeScaledMeasurement(
  attributeId: number,
  value: unknown,
  cap: MatterEndpointCap,
  field: string,
  scale: number,
): DecodedAttribute | null {
  if (attributeId !== MatterAttributeId.MeasuredValue) return null
  const raw = asNumber(value)
  // Matter uses a sentinel (null / 0x8000) for "unknown"; treat null as no value.
  if (raw === null) return null
  return { cap, patch: { [field]: raw * scale, lastFetchedAt: Date.now() } }
}

function decodeIlluminance(attributeId: number, value: unknown): DecodedAttribute | null {
  if (attributeId !== MatterAttributeId.MeasuredValue) return null
  const raw = asNumber(value)
  if (raw === null || raw <= 0) return null
  // IlluminanceMeasurement.MeasuredValue = 10000 × log10(lux) + 1 ⇒ invert.
  const lux = Math.round(10 ** ((raw - 1) / 10000))
  return { cap: 'ambient-light-sensor', patch: { lux, lastFetchedAt: Date.now() } }
}

function decodeBattery(attributeId: number, value: unknown): DecodedAttribute | null {
  if (attributeId === MatterAttributeId.BatPercentRemaining) {
    const half = asNumber(value)
    if (half === null) return null
    // PowerSource.BatPercentRemaining is in half-percent (0..200) → 0..100.
    const percentage = Math.max(0, Math.min(100, Math.round(half / 2)))
    return { cap: 'battery', patch: { percentage, lastUpdated: Date.now() } }
  }
  if (attributeId === MatterAttributeId.BatChargeState) {
    const state = asNumber(value)
    if (state === null) return null
    // 1 = IsCharging → 'charging'; everything else → 'none'.
    const charging = state === 1 ? 'in' : 'none'
    return { cap: 'battery', patch: { charging, lastUpdated: Date.now() } }
  }
  return null
}

function decodeThermostat(attributeId: number, value: unknown): DecodedAttribute | null {
  switch (attributeId) {
    case MatterAttributeId.LocalTemperature: {
      const raw = asNumber(value)
      return raw === null
        ? null
        : { cap: 'climate-control', patch: { currentTemp: raw * 0.01, lastFetchedAt: Date.now() } }
    }
    case MatterAttributeId.OccupiedHeatingSetpoint:
    case MatterAttributeId.OccupiedCoolingSetpoint: {
      const raw = asNumber(value)
      return raw === null
        ? null
        : { cap: 'climate-control', patch: { target: raw * 0.01, lastFetchedAt: Date.now() } }
    }
    case MatterAttributeId.SystemMode: {
      const raw = asNumber(value)
      if (raw === null) return null
      const mode = SYSTEM_MODE_TO_HVAC.get(raw)
      return mode === undefined
        ? null
        : { cap: 'climate-control', patch: { mode, lastFetchedAt: Date.now() } }
    }
    default:
      return null
  }
}

function decodeElectricalPower(attributeId: number, value: unknown): DecodedAttribute | null {
  switch (attributeId) {
    case MatterAttributeId.ActivePower: {
      const mw = asNumber(value)
      return mw === null
        ? null
        : { cap: 'power-meter', patch: { watts: mw / 1000, lastFetchedAt: Date.now() } }
    }
    case MatterAttributeId.Voltage: {
      const mv = asNumber(value)
      return mv === null
        ? null
        : { cap: 'power-meter', patch: { volts: mv / 1000, lastFetchedAt: Date.now() } }
    }
    case MatterAttributeId.ActiveCurrent: {
      const ma = asNumber(value)
      return ma === null
        ? null
        : { cap: 'power-meter', patch: { amps: ma / 1000, lastFetchedAt: Date.now() } }
    }
    default:
      return null
  }
}

function decodeElectricalEnergy(attributeId: number, value: unknown): DecodedAttribute | null {
  if (attributeId !== MatterAttributeId.CumulativeEnergyImported) return null
  const mwh = asEnergyMilliWattHours(value)
  if (mwh === null) return null
  // mWh → kWh (÷ 1e6).
  return { cap: 'power-meter', patch: { kwhTotal: mwh / 1_000_000, lastFetchedAt: Date.now() } }
}
