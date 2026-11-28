import { DeviceType } from '@dominevo/types'

/**
 * The Dominevo-supported Dreo device kinds, derived from the model prefix. Anything outside this set is
 * `unsupported` and skipped during discovery / adoption.
 *
 * - `fan` — tower fans + air circulators, ceiling fans and evaporative coolers. Mapped to `fan-control` + `switch`.
 * - `purifier` — air purifiers. Mapped to `fan-control` +
 *   `switch` + `air-quality-sensor` (it reports PM2.5).
 * - `heater` — heaters. Mapped to `switch` + `temperature-sensor`
 *   (no setpoint surface on the library — see TODO in the heater device).
 * - `humidifier` — humidifiers. Mapped to `switch` +
 *   `humidity-sensor` (it reports `rh`).
 */
export type DreoDeviceKind = 'fan' | 'purifier' | 'heater' | 'humidifier' | 'unsupported'

/** Model prefix → device family, first match wins (the Dreo cloud's model naming). */
const MODEL_PREFIXES: readonly (readonly [string, DreoDeviceKind])[] = [
  ['DR-HPF', 'fan'],
  ['DR-HAF', 'fan'],
  ['DR-HTF', 'fan'],
  ['DR-HCF', 'fan'],
  ['DR-HEC', 'fan'],
  ['DR-HSH', 'heater'],
  ['WH', 'heater'],
  ['DR-HHM', 'humidifier'],
  ['DR-HAP', 'purifier'],
  // Portable AC, dehumidifier and the chef maker have no surface yet.
  ['DR-HAC', 'unsupported'],
  ['DR-HDH', 'unsupported'],
  ['DR-KCM', 'unsupported'],
]

/**
 * Classify a Dreo cloud `model` string into a supported Dominevo device kind by its prefix.
 * Pure.
 *
 * NOTE: `ac` (portable AC) and `dehumidifier` are intentionally `unsupported`
 * for this INITIAL version. The Gree addon owns the climate-control surface; Dreo
 * portable ACs are a follow-up.
 */
export function classifyDreoModel(model: string): DreoDeviceKind {
  for (const [prefix, kind] of MODEL_PREFIXES) {
    if (model.startsWith(prefix)) return kind
  }
  return 'unsupported'
}

/** The Dominevo {@link DeviceType} for a supported Dreo kind. */
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
 * `DREO_MAX_FAN_LEVEL` is the ceiling used when the device does not report its own range
 * (the worker reports `speedMax` per model; tower fans top out at 9, air circulators at 4-6).
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
  // Not rounded: a rounded step (13 for 8 levels) makes the slider snap to 91 and never reach 100.
  return 100 / maxLevel
}

/** Clamp a raw battery / percentage-ish number into the 0..100 inclusive range. */
export function clampPercent(value: number | null | undefined): number | null {
  if (value === undefined || value === null || Number.isNaN(value)) return null
  return Math.max(0, Math.min(100, value))
}
