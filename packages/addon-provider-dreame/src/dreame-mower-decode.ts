import {
  type MowerConsumableKey,
  type MowerConsumableReading,
  MowerStatus,
} from '@apocaliss92/nodedreame'
import type { ConsumableItem, LawnMowerActivity } from '@camstack/types'

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
