import {
  type MowerConsumableKey,
  type MowerConsumableReading,
  MowerChargingStatus,
  MowerFault,
  MowerStatus,
  mowerFaultSeverity,
} from '@apocaliss92/nodedreame'
import { ERROR_STATUS_COLD } from '@dominevo/types'
import type { ConsumableItem, DeviceFault, ErrorStatus, LawnMowerActivity } from '@dominevo/types'

/**
 * Pure decode helper for the Dreame mower. Translate the library's
 * {@link MowerStatus} enum (siid 2 piid 1) into the camstack
 * `lawn-mower-control` canonical activity (`idle` / `mowing` / `paused` /
 * `docked` / `error`). Unit-tested in isolation.
 *
 * A `null` status (not yet observed) settles on `idle`. Unrecognised codes
 * fall through to `idle` so a firmware-added value never throws.
 */
export function mapMowerStatusToActivity(status: MowerStatus | null): LawnMowerActivity {
  if (status === null) return 'idle'
  switch (status) {
    case MowerStatus.Mowing:
      return 'mowing'
    case MowerStatus.Paused:
      return 'paused'
    case MowerStatus.PausedDueToErrors:
      return 'error'
    case MowerStatus.Charging:
    case MowerStatus.ChargingComplete:
      return 'docked'
    case MowerStatus.ReturningToCharge:
      // Returning to the dock is in-transit work — surface as mowing-adjacent
      // activity; the lawn-mower cap has no dedicated "returning" state, so we
      // map it onto `mowing` (active) rather than `idle`.
      return 'mowing'
    case MowerStatus.NoStatus:
    case MowerStatus.Standby:
    case MowerStatus.Mapping:
    case MowerStatus.Updating:
      return 'idle'
    default:
      return 'idle'
  }
}

/** Clamp a raw battery reading (0..100 from the library) to the slice field. */
export function clampBatteryLevel(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(100, value))
}

/**
 * The mower fields the `error` cap reading is built from. `faultRaw` is
 * DEVICE_CODE (2:2); `charging` is CHARGING_STATUS (3:2).
 */
export interface MowerErrorInput {
  /** `null` means the shadow has not answered — the reading stays unknown. */
  faultRaw: number | null
  charging: MowerChargingStatus | null
}

/**
 * Charging paused because the battery is too cold (donor issue #40). A warning
 * of its own: it is the principal fault only when no device fault is active.
 */
const LOW_TEMPERATURE_CHARGE_PAUSE: DeviceFault = {
  code: `charging-${MowerChargingStatus.ChargingPausedLowTemperature}`,
  label: 'Charging paused: battery too cold',
  severity: 'warning',
}

/** Split a PascalCase enum name into words, the same way the vacuum does. */
function faultWords(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
}

/**
 * One device-code fault, or null when the code is info (a status, not a fault)
 * — including `NoDeviceCode`. Severity comes from {@link mowerFaultSeverity}.
 */
function deviceFault(code: number): DeviceFault | null {
  const severity = mowerFaultSeverity(code)
  if (severity === 'info') return null
  const name = MowerFault[code]
  const label = typeof name === 'string' ? faultWords(name) : `Error ${code}`
  return { code: String(code), label, severity }
}

/**
 * The `error` cap reading for a mower. A `null` device code is UNKNOWN
 * (`active: null`, never "no fault"). Info codes are a clean `active: false`.
 * A warning or error code is active at that severity. A low-temperature
 * charging pause is an extra warning in `faults`, and the principal only when
 * the device code itself is not a fault.
 */
export function mowerErrorReading(input: MowerErrorInput, now: number): ErrorStatus {
  if (input.faultRaw === null) return { ...ERROR_STATUS_COLD, lastFetchedAt: now }
  const faults: DeviceFault[] = []
  const device = deviceFault(input.faultRaw)
  if (device !== null) faults.push(device)
  if (input.charging === MowerChargingStatus.ChargingPausedLowTemperature) {
    faults.push(LOW_TEMPERATURE_CHARGE_PAUSE)
  }
  const principal = faults[0]
  if (principal === undefined) {
    return { ...ERROR_STATUS_COLD, active: false, lastFetchedAt: now }
  }
  return {
    active: true,
    code: principal.code,
    label: principal.label,
    severity: principal.severity,
    since: null,
    faults,
    lastFetchedAt: now,
  }
}

/** Clamp a 0..100 percentage (mowing progress), null-safe. */
export function clampPercent(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(100, value))
}

/** Human label per CMS consumable key (the cap renders this verbatim). */
const MOWER_CONSUMABLE_LABEL: Record<MowerConsumableReading['key'], string> = {
  blade: 'Blade',
  brush: 'Brush',
  maintenance: 'Maintenance',
}

/** Narrow a cap-supplied reset key to a canonical CMS consumable key. The mower
 *  only ever exposes these three (see {@link buildMowerConsumables}). */
export function isMowerConsumableKey(key: string): key is MowerConsumableKey {
  return key === 'blade' || key === 'brush' || key === 'maintenance'
}

/**
 * Map the library's CMS consumable readings (blade/brush/maintenance, remaining
 * %) to the `consumables` cap items. All three drive a real CMS reset, so every
 * item is `resettable`.
 *
 * `status` is `null`: the provider reports the LEVEL and gives no verdict. When
 * a level is "low" is the notification rule's threshold (operator, per rule);
 * a provider constant here used to flag `replace` at 10 % and override it.
 */
export function buildMowerConsumables(
  readings: readonly MowerConsumableReading[],
): readonly ConsumableItem[] {
  return readings.map((r) => ({
    key: r.key,
    label: MOWER_CONSUMABLE_LABEL[r.key],
    level: r.remainingPercent,
    status: null,
    lastResetAt: null,
    resettable: true,
    // Blades and brushes: parts that wear.
    form: 'part' as const,
  }))
}
