/**
 * One-shot rescales of series whose every stored point shared one factor
 * (D944). A reading already in the base unit is at or above `legacyMax` and
 * is left alone, so a second pass does not multiply it again.
 *
 * Rollup `sum` / `tw_sum` follow the bucket when min, max and last are still
 * in the old unit. Judging the sum itself would skip a day's samples of a
 * large gauge (many × GiB already exceeds the ceiling) and keep the raw
 * points and the rollup in different units.
 */

export const GIB_TO_BYTES: number = 1024 ** 3
export const DAY_TO_SECONDS: number = 86_400

/** A homelab array in GiB is below 1 MiB; the same array in bytes is not. */
export const INFORMATION_LEGACY_MAX: number = 1024 ** 2

/** Desiccant life in days is below this; the same life in seconds is not. */
export const DESICCANT_LEGACY_MAX_DAYS: number = 10_000

export const DESICCANT_SERIES_KEY: string = 'cap:pet-feeder.desiccantLeftDays'
export const DESICCANT_SCALE_ID: string = 'pet-feeder-desiccant-days-to-seconds'

export const UNRAID_INFORMATION_KEYS: readonly string[] = [
  'array_total',
  'array_used',
  'array_free',
]
export const NUMERIC_SENSOR_SERIES_KEY: string = 'cap:numeric-sensor.value'
export const UNRAID_ADDON_ID: string = 'provider-unraid'

export interface LegacyScale {
  readonly seriesKey: string
  readonly deviceId: number
  readonly factor: number
  readonly legacyMax: number
  readonly migrationId: string
}

/** The stored number after one rescale, or the same number when it is already base. */
export function scaledMagnitude(value: number, factor: number, legacyMax: number): number {
  if (!Number.isFinite(value) || value === 0) return value
  if (Math.abs(value) >= legacyMax) return value
  return value * factor
}

export function rollupIsLegacy(
  row: { readonly min: number; readonly max: number; readonly last: number | null },
  legacyMax: number,
): boolean {
  const samples = [row.min, row.max, ...(row.last === null ? [] : [row.last])]
  if (samples.some((value) => !Number.isFinite(value))) return false
  if (samples.every((value) => value === 0)) return false
  return samples.every((value) => Math.abs(value) < legacyMax)
}

/** Unraid array capacity children. Other numeric sensors on the same key stay put. */
export function unraidInformationScale(deviceId: number, entityKey: string): LegacyScale | null {
  if (!UNRAID_INFORMATION_KEYS.includes(entityKey)) return null
  return {
    seriesKey: NUMERIC_SENSOR_SERIES_KEY,
    deviceId,
    factor: GIB_TO_BYTES,
    legacyMax: INFORMATION_LEGACY_MAX,
    migrationId: `unraid-gib-to-bytes:${String(deviceId)}`,
  }
}
