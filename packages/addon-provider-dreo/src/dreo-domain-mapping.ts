import { DeviceType } from '@camstack/types'
import { deviceTypeForModel, type DeviceType as DreoLibDeviceType } from '@apocaliss92/nodedreo'

/**
 * The CamStack-supported Dreo device kinds. Derived from the library's
 * `deviceTypeForModel(model)` classification. Anything outside this set is
 * `unsupported` and skipped during discovery / adoption.
 *
 * - `fan` — tower fans + air circulators (library `towerFan` / `airCirculator` /
 *   `ceilingFan` / `evaporativeCooler`). Mapped to `fan-control` + `switch`.
 * - `purifier` — air purifiers (library `airPurifier`). Mapped to `fan-control` +
 *   `switch` + `air-quality-sensor` (it reports PM2.5).
 * - `heater` — heaters (library `heater`). Mapped to `switch` + `temperature-sensor`
 *   (no setpoint surface on the library — see TODO in the heater device).
 * - `humidifier` — humidifiers (library `humidifier`). Mapped to `switch` +
 *   `humidity-sensor` (it reports `rh`).
 */
export type DreoDeviceKind = 'fan' | 'purifier' | 'heater' | 'humidifier' | 'unsupported'

/** Library device-type strings we treat as a CamStack `fan` kind. */
const FAN_LIB_TYPES: ReadonlySet<DreoLibDeviceType> = new Set<DreoLibDeviceType>([
  'towerFan',
  'airCirculator',
  'ceilingFan',
  'evaporativeCooler',
])

/**
 * Classify a Dreo cloud `model` string into a supported CamStack device kind.
 * Pure — delegates the model→library-type resolution to the library's
 * `deviceTypeForModel` so model-prefix knowledge stays in one place.
 *
 * NOTE: `ac` (portable AC) and `dehumidifier` are intentionally `unsupported`
 * for this INITIAL version — see the package report's flagged TODOs. The Gree
 * addon owns the climate-control surface; Dreo portable ACs are a follow-up.
 */
export function classifyDreoModel(model: string): DreoDeviceKind {
  const libType = deviceTypeForModel(model)
  if (FAN_LIB_TYPES.has(libType)) return 'fan'
  if (libType === 'airPurifier') return 'purifier'
  if (libType === 'heater') return 'heater'
  if (libType === 'humidifier') return 'humidifier'
  return 'unsupported'
}

/** The CamStack {@link DeviceType} for a supported Dreo kind. */
export function deviceTypeForKind(kind: Exclude<DreoDeviceKind, 'unsupported'>): DeviceType {
  switch (kind) {
    case 'fan':
    case 'purifier':
      return DeviceType.Fan
    case 'heater':
      // The heater has no setpoint surface on the library, so it is modelled as a
      // switch + temperature readout rather than a Thermostat. Sensor parents it.
      return DeviceType.Sensor
    case 'humidifier':
      return DeviceType.Humidifier
  }
}

/**
 * The device-scoped capability names a supported Dreo accessory child registers.
 * Drives the adoption candidate's `capabilities` list (display only) and the
 * device's own `registerNativeCap` calls. Pure.
 */
export function capsForKind(kind: Exclude<DreoDeviceKind, 'unsupported'>): readonly string[] {
  switch (kind) {
    case 'fan':
      return ['switch', 'fan-control']
    case 'purifier':
      return ['switch', 'fan-control', 'air-quality-sensor']
    case 'heater':
      return ['switch', 'temperature-sensor']
    case 'humidifier':
      return ['switch', 'humidity-sensor']
  }
}

// ---------------------------------------------------------------------------
// Fan-speed mapping (wind level ↔ percentage)
// ---------------------------------------------------------------------------

/**
 * Dreo fans expose a discrete `windlevel` / `speed` integer (1..maxLevel). The
 * `fan-control` cap models a 0..100 percentage. These two helpers convert
 * between the two representations using the device's max level so the UI slider
 * and the wire value agree. Pure.
 *
 * `DREO_MAX_FAN_LEVEL` is the assumed ceiling — Dreo tower fans top out at 9 and
 * air circulators at 4–6. The library does not expose the per-model max, so we
 * use a conservative constant and clamp; a per-model max is a flagged TODO.
 */
export const DREO_MAX_FAN_LEVEL = 9

/** Convert a Dreo wind level (1..max) to a 0..100 percentage. */
export function levelToPercentage(level: number, maxLevel: number = DREO_MAX_FAN_LEVEL): number {
  if (maxLevel <= 0) return 0
  const clamped = Math.max(0, Math.min(level, maxLevel))
  return Math.round((clamped / maxLevel) * 100)
}

/** Convert a 0..100 percentage to a Dreo wind level (1..max) when on. */
export function percentageToLevel(
  percentage: number,
  maxLevel: number = DREO_MAX_FAN_LEVEL,
): number {
  const clampedPct = Math.max(0, Math.min(percentage, 100))
  if (clampedPct <= 0) return 0
  const level = Math.round((clampedPct / 100) * maxLevel)
  return Math.max(1, Math.min(level, maxLevel))
}

/** The percentage step a Dreo fan slider should snap to, given its max level. */
export function percentageStep(maxLevel: number = DREO_MAX_FAN_LEVEL): number {
  if (maxLevel <= 0) return 1
  return Math.round((1 / maxLevel) * 100)
}

/** Clamp a raw battery / percentage-ish number into the 0..100 inclusive range. */
export function clampPercent(value: number | undefined): number | null {
  if (value === undefined || Number.isNaN(value)) return null
  return Math.max(0, Math.min(100, value))
}
