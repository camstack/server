import { z } from 'zod'
import { ReadingQuantitySchema } from '../units/quantity.js'

/**
 * Identity envelope for a device's upstream-system metadata.
 *
 * Two jobs:
 *
 *   1. **Dispatch key.** `id` is the natural identifier the SOURCE system
 *      uses to address this device (HA `entity_id`, Reolink MAC, ONVIF
 *      WS-Discovery endpoint UUID, …). Provider code keeps a
 *      `Map<sourceInfo.id, IDevice>` to route inbound push events in O(1)
 *      without round-tripping through `stableId` / `id` mappings.
 *
 *   2. **Stability bridge.** `uniqueId` is the *immutable* upstream id when
 *      one exists (HA `entity.unique_id`, Reolink MAC again — same as `id`
 *      for vendors where MAC is the natural key). For systems where the
 *      live dispatch key can be renamed (HA `entity_id` can be edited),
 *      providers detect renames by matching `uniqueId` and patch `id`
 *      in-place so dispatch keeps working.
 *
 * **Display unit and precision are NOT stored here.** They are a read-time
 * preference (D944). A polymorphic reading stores its `quantity` here once,
 * at adopt, and a date/time value stores `dateTimeShape` the same way —
 * neither is repeated on each sample. The `device_class` tag is an
 * HA-specific input consumed at the discovery boundary (`ha-domain-mapping`)
 * to derive the CamStack `DeviceRole`; it is never stored after that point.
 *
 * The `raw` escape hatch carries provider-specific attributes that don't
 * fit the structured slots (HA `attributes` whitelist, Reolink `deviceCache`
 * details, …). Providers control what lands here.
 */
export const SourceInfoSchema = z.object({
  // ── Identity (required) ─────────────────────────────────────────
  /** Live dispatch key — mutable when the source system allows rename. */
  id: z.string(),
  /** Source system tag — e.g. 'homeassistant' | 'reolink' | 'onvif'. */
  system: z.string(),

  // ── Stability (optional) ────────────────────────────────────────
  /** Immutable upstream identifier when available (HA `unique_id`, … ).
   *  Used to detect rename when `id` changes. */
  uniqueId: z.string().optional(),

  /** Quantity of a polymorphic reading, written once at adopt (D944). */
  quantity: ReadingQuantitySchema.optional(),
  /** Date / time / datetime shape of a string reading, written once at adopt. */
  dateTimeShape: z.enum(['date', 'time', 'datetime']).optional(),

  // ── Free-form passthrough ───────────────────────────────────────
  /** Provider-specific extras that don't fit the structured slots.
   *  Whitelist what goes here per provider — do NOT dump entire HA
   *  attribute blobs (would explode the meta JSON column). */
  raw: z.record(z.string(), z.unknown()).optional(),
})

export type SourceInfo = z.infer<typeof SourceInfoSchema>

/**
 * Build the synthetic SourceInfo every existing provider falls back to
 * when no upstream value has been persisted. Keeps non-migrated providers
 * (Reolink / Hikvision / ONVIF / RTSP) functional without code
 * changes — `id` reuses the CamStack stableId, `system` reuses the addon
 * id. Real upstream identity replaces this once a provider migrates and
 * calls `updateSourceInfo()` with concrete values.
 */
export function synthesizeSourceInfo(input: { stableId: string; addonId: string }): SourceInfo {
  return {
    id: input.stableId,
    system: input.addonId,
  }
}

/**
 * Shallow-merge a partial patch over a prior SourceInfo. `undefined`
 * patch values are ignored (no field clobber); to clear a field
 * explicitly, providers omit it from the patch and rebuild from scratch
 * via `updateSourceInfo({})` cycles — uncommon enough that we don't
 * bother with a `null`-means-delete sentinel.
 *
 * The `raw` field is also shallow-merged: passing `raw: { foo: 1 }`
 * merges over existing `raw` keys instead of replacing the whole bag.
 */
export function mergeSourceInfo(prev: SourceInfo, patch: Partial<SourceInfo>): SourceInfo {
  const next: SourceInfo = { ...prev }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    if (k === 'raw' && typeof v === 'object' && v !== null) {
      next.raw = { ...prev.raw, ...(v as Record<string, unknown>) }
      continue
    }
    ;(next as Record<string, unknown>)[k] = v
  }
  return next
}

/**
 * Coerce common unit-of-measurement string variants to a canonical form
 * so the UI's display templates can rely on stable strings. Pure
 * passthrough for unknown units — kept conservative on purpose, the goal
 * is to normalise the long tail of HA `unit_of_measurement` values that
 * have multiple historical spellings (`'°C'` vs `'C'` vs `'celsius'`).
 *
 * Extend the map as we encounter real-world data. Returning the raw
 * input for unknown values is intentional: providers should never
 * lose information silently here.
 */
export function normalizeUnit(raw: string | null | undefined): string | undefined {
  if (raw == null) return undefined
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  const lower = trimmed.toLowerCase()
  // Temperature
  if (lower === '°c' || lower === 'c' || lower === 'celsius') return '°C'
  if (lower === '°f' || lower === 'f' || lower === 'fahrenheit') return '°F'
  if (lower === 'k' || lower === 'kelvin') return 'K'
  // Common percentages / illuminance / pressure
  if (lower === '%' || lower === 'percent' || lower === 'percentage') return '%'
  if (lower === 'lx' || lower === 'lux') return 'lx'
  if (lower === 'hpa' || lower === 'hectopascal') return 'hPa'
  if (lower === 'kpa') return 'kPa'
  if (lower === 'pa') return 'Pa'
  if (lower === 'mbar' || lower === 'millibar') return 'mbar'
  // Power / energy / current / voltage
  if (lower === 'w' || lower === 'watt') return 'W'
  if (lower === 'kw' || lower === 'kilowatt') return 'kW'
  if (lower === 'wh' || lower === 'watt-hour') return 'Wh'
  if (lower === 'kwh' || lower === 'kilowatt-hour') return 'kWh'
  if (lower === 'v' || lower === 'volt') return 'V'
  if (lower === 'a' || lower === 'amp' || lower === 'ampere') return 'A'
  if (lower === 'ma' || lower === 'milliampere') return 'mA'
  if (lower === 'va') return 'VA'
  // Air quality
  if (lower === 'ppm') return 'ppm'
  if (lower === 'ppb') return 'ppb'
  if (lower === 'µg/m³' || lower === 'ug/m3' || lower === 'µg/m3') return 'µg/m³'
  // Distance / speed / weight (passthrough common units)
  if (lower === 'km/h' || lower === 'kph') return 'km/h'
  if (lower === 'mph') return 'mph'
  if (lower === 'm/s') return 'm/s'
  if (lower === 'm') return 'm'
  if (lower === 'm²' || lower === 'm2') return 'm²'
  if (lower === 'mm') return 'mm'
  if (lower === 'cm') return 'cm'
  if (lower === 'km') return 'km'
  if (lower === 'in' || lower === 'inch' || lower === 'inches') return 'in'
  if (lower === 'ft' || lower === 'foot' || lower === 'feet') return 'ft'
  if (lower === 'kg') return 'kg'
  if (lower === 'g') return 'g'
  if (
    lower === 'l' ||
    lower === 'liter' ||
    lower === 'litre' ||
    lower === 'liters' ||
    lower === 'litres'
  )
    return 'L'
  if (lower === 'ml') return 'mL'
  if (lower === 'gal' || lower === 'gallon' || lower === 'gallons') return 'gal'
  if (lower === 's' || lower === 'sec' || lower === 'second' || lower === 'seconds') return 's'
  if (lower === 'ms') return 'ms'
  if (lower === 'min' || lower === 'minute' || lower === 'minutes') return 'min'
  if (lower === 'h' || lower === 'hr' || lower === 'hour' || lower === 'hours') return 'h'
  if (lower === 'd' || lower === 'day' || lower === 'days') return 'd'
  if (lower === 'b' || lower === 'byte' || lower === 'bytes') return 'B'
  if (lower === 'kib') return 'KiB'
  if (lower === 'mib') return 'MiB'
  if (lower === 'gib') return 'GiB'
  if (lower === 'tib') return 'TiB'
  if (lower === 'kb') return 'kB'
  if (lower === 'mb') return 'MB'
  if (lower === 'gb') return 'GB'
  if (lower === 'dbm') return 'dBm'
  if (lower === 'dbfs') return 'dBFS'
  if (lower === 'inhg') return 'inHg'
  if (lower === 'mm/h') return 'mm/h'
  if (lower === 'w/m²' || lower === 'w/m2') return 'W/m²'
  if (lower === '°' || lower === 'deg' || lower === 'degree' || lower === 'degrees') return '°'
  if (lower === 'kbps') return 'kbps'
  if (lower === 'fps') return 'fps'
  return trimmed
}

/**
 * Key under which `SourceInfo` lives inside `DeviceMeta.metadata`. The
 * blob is a free-form `Record<string, unknown>` shared with hardware-
 * identity fields (`manufacturer`, `model`, `firmware`, …); SourceInfo
 * lives under a single nested key to keep it composable with those.
 */
export const SOURCE_INFO_METADATA_KEY = 'sourceInfo'

/**
 * Extract a SourceInfo from a `DeviceMeta.metadata` blob, validating
 * with Zod. Returns `null` when the blob is missing or the nested
 * `sourceInfo` key fails validation — callers fall back to the
 * synthetic default in that case (see `synthesizeSourceInfo`).
 */
export function extractSourceInfoFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): SourceInfo | null {
  if (!metadata) return null
  const raw = metadata[SOURCE_INFO_METADATA_KEY]
  if (!raw) return null
  const parsed = SourceInfoSchema.safeParse(raw)
  if (!parsed.success) return null
  return parsed.data
}
