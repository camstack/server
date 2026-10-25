import { DeviceType } from '@camstack/types'

/**
 * Pure DP (data-point) ⇄ CamStack-cap mapping for Tuya devices. NO I/O, NO
 * side-effects — every function takes a plain DP map (as reported by
 * `TuyaDevice.get()` / a `dps` push) and returns a value, or produces the DP
 * patch to write for a control. Unit-tested in isolation with fake DP maps.
 *
 * Tuya devices are "thin per-DP": a wall switch is one boolean DP; a kettle is a
 * handful of DPs (a power boolean, a keep-warm boolean, an integer target-temp,
 * an integer current-temp, an enum status string). The DP *numbers* vary per
 * product, so they are carried in the device config (with the documented defaults
 * below) rather than hard-coded — this module only knows how to READ/WRITE a DP
 * of a given shape.
 */

// ---------------------------------------------------------------------------
// Category classification (which CamStack DeviceType a cloud device becomes)
// ---------------------------------------------------------------------------

/** The device kinds this addon maps in v1. */
export type TuyaDeviceKind = 'switch' | 'kettle'

/**
 * Tuya product-category codes that denote a water-heater-family KETTLE
 * (`bh` = electric kettle / 水壶, `js` = water purifier/heater variants). These
 * become a {@link DeviceType.Container} that fans out the kettle's per-DP
 * children (power switch, keep-warm switch, target-temp select, current-temp +
 * status sensors). Everything else is treated as a raw on/off SWITCH.
 */
export const KETTLE_CATEGORIES: readonly string[] = ['bh']

/**
 * Classify a cloud device by its Tuya `category` code. Unknown / absent
 * categories default to `switch` (the breadth-safe majority case — wall/ceiling
 * light switches, sockets), so an unrecognised device still adopts as a
 * controllable on/off switch rather than being dropped.
 */
export function classifyTuyaCategory(category: string | undefined): TuyaDeviceKind {
  if (category !== undefined && KETTLE_CATEGORIES.includes(category)) return 'kettle'
  return 'switch'
}

/** The top-level CamStack DeviceType a device kind adopts as. */
export function deviceTypeForKind(kind: TuyaDeviceKind): DeviceType {
  return kind === 'kettle' ? DeviceType.Container : DeviceType.Switch
}

// ---------------------------------------------------------------------------
// Generic DP readers / writers
// ---------------------------------------------------------------------------

/** Read a boolean DP (Tuya reports on/off as `true`/`false` or `1`/`0`), or null. */
export function readBooleanDp(
  dps: Readonly<Record<string, unknown>>,
  dpId: string,
): boolean | null {
  const v = dps[dpId]
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  return null
}

/** The DP patch that writes a boolean DP (for `TuyaDevice.set`). */
export function booleanDpPatch(dpId: string, on: boolean): Record<string, boolean> {
  return { [dpId]: on }
}

/** Read a finite-number DP, or null when absent / non-numeric. */
export function readNumberDp(dps: Readonly<Record<string, unknown>>, dpId: string): number | null {
  const v = dps[dpId]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** The DP patch that writes an integer DP. */
export function numberDpPatch(dpId: string, value: number): Record<string, number> {
  return { [dpId]: value }
}

/** Read an enum/string DP (Tuya enum DPs report a string; numbers are coerced), or null. */
export function readStringDp(dps: Readonly<Record<string, unknown>>, dpId: string): string | null {
  const v = dps[dpId]
  if (typeof v === 'string') return v
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return null
}

// ---------------------------------------------------------------------------
// Switch (DeviceType.Switch → `switch` cap)
// ---------------------------------------------------------------------------

/** Default boolean DP a single-gang Tuya switch/socket exposes. */
export const DEFAULT_SWITCH_DP = '1'

// ---------------------------------------------------------------------------
// Kettle (DeviceType.Container → per-DP children)
// ---------------------------------------------------------------------------

/**
 * Default DP numbers for a Tuya kettle (`category: bh`). These are the common
 * layout; the exact numbers are product-specific and are overridable on the
 * device config — Phase-C live onboarding calibrates them against the real
 * device. `tempScale` is the divisor applied to the raw integer temp DPs (some
 * kettles report deci-degrees, i.e. `850` → `85.0 °C`; default `1` = whole °C).
 */
export interface TuyaKettleDpMap {
  /** Boolean power / boil DP. */
  readonly powerDp: string
  /** Boolean keep-warm DP. */
  readonly keepWarmDp: string
  /** Integer target-temperature (setpoint) DP. */
  readonly targetTempDp: string
  /** Integer current-temperature DP. */
  readonly currentTempDp: string
  /** Enum status DP (string, e.g. `heating` / `warm` / `standby`). */
  readonly statusDp: string
  /** Divisor for the raw integer temperature DPs. */
  readonly tempScale: number
}

/** The kettle target-temperature options localtuya surfaces (°C). */
export const DEFAULT_KETTLE_TARGET_OPTIONS: readonly string[] = ['70', '80', '90', '100']

export const DEFAULT_KETTLE_DP_MAP: TuyaKettleDpMap = {
  powerDp: '1',
  keepWarmDp: '13',
  targetTempDp: '5',
  currentTempDp: '4',
  statusDp: '105',
  tempScale: 1,
}

/** Read the kettle's current temperature (°C) from its DP map, or null. */
export function readKettleCurrentTemp(
  dps: Readonly<Record<string, unknown>>,
  map: TuyaKettleDpMap,
): number | null {
  const raw = readNumberDp(dps, map.currentTempDp)
  if (raw === null) return null
  return map.tempScale === 1 ? raw : raw / map.tempScale
}

/** Read the kettle's target-temperature setpoint as a select LABEL (°C string), or null. */
export function readKettleTargetLabel(
  dps: Readonly<Record<string, unknown>>,
  map: TuyaKettleDpMap,
): string | null {
  const raw = readNumberDp(dps, map.targetTempDp)
  if (raw === null) return null
  const degrees = map.tempScale === 1 ? raw : raw / map.tempScale
  return String(Math.round(degrees))
}

/** The DP patch that sets the kettle target-temperature from a select label (°C string). */
export function kettleTargetPatch(
  map: TuyaKettleDpMap,
  label: string,
): Record<string, number> | null {
  const degrees = Number.parseInt(label, 10)
  if (!Number.isFinite(degrees)) return null
  const raw = map.tempScale === 1 ? degrees : Math.round(degrees * map.tempScale)
  return numberDpPatch(map.targetTempDp, raw)
}

/** Read the kettle status enum (raw string), or null. */
export function readKettleStatus(
  dps: Readonly<Record<string, unknown>>,
  map: TuyaKettleDpMap,
): string | null {
  return readStringDp(dps, map.statusDp)
}
