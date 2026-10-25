/**
 * Pure helpers for the device-table `manufacturer` column.
 *
 * A device's hardware/identity blob lives in `DeviceItemDevice.metadata`
 * (mirror of `DeviceInfo.metadata`) — a driver-populated, free-form
 * `Record<string, unknown>`. Keys are NOT a fixed enum; values are arbitrary.
 * These helpers coerce that untrusted blob into safe display strings:
 *
 *   - `metadataString` — read ONE key as a trimmed non-empty string, else null.
 *   - `hardwareLabel` — the compact cell text (`manufacturer · model`).
 *   - `metadataEntries` — the full key/value list for the tooltip (only
 *      string-coercible, non-empty values; stable insertion order).
 *   - `compareHardware` — comparator on `manufacturer` then `model`.
 *
 * The `unknown` → string boundary is handled with a `typeof === 'string'`
 * guard plus a numeric/boolean coercion fallback; objects/arrays/null are
 * skipped (never `String([object Object])`).
 */
import type { DeviceItemDevice } from '../device-item/helpers'

const MANUFACTURER_KEY = 'manufacturer'
const MODEL_KEY = 'model'

/** Coerce a single metadata value to a trimmed, non-empty display string.
 *  Strings pass through (trimmed); finite numbers + booleans coerce; every
 *  other shape (object, array, null, undefined, NaN) yields `null` so callers
 *  skip it rather than render a useless `[object Object]`. */
export function metadataValueString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed === '' ? null : trimmed
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return String(value)
  return null
}

/** Read one metadata key as a safe display string (null when absent/empty). */
export function metadataString(
  metadata: Readonly<Record<string, unknown>> | null | undefined,
  key: string,
): string | null {
  if (metadata === null || metadata === undefined) return null
  return metadataValueString(metadata[key])
}

/** Compact cell text: `manufacturer · model`, or whichever is present, or
 *  `null` when neither is a usable string (caller renders the empty state). */
export function hardwareLabel(device: DeviceItemDevice): string | null {
  const manufacturer = metadataString(device.metadata, MANUFACTURER_KEY)
  const model = metadataString(device.metadata, MODEL_KEY)
  if (manufacturer !== null && model !== null) return `${manufacturer} · ${model}`
  return manufacturer ?? model ?? null
}

/** A single key/value pair for the metadata tooltip dump. */
export interface MetadataEntry {
  readonly key: string
  readonly value: string
}

/** All string-coercible, non-empty metadata entries in insertion order — the
 *  full identity blob for the tooltip. Empty array when there's nothing to show. */
export function metadataEntries(
  metadata: Readonly<Record<string, unknown>> | null | undefined,
): readonly MetadataEntry[] {
  if (metadata === null || metadata === undefined) return []
  const entries: MetadataEntry[] = []
  for (const key of Object.keys(metadata)) {
    const value = metadataValueString(metadata[key])
    if (value !== null) entries.push({ key, value })
  }
  return entries
}

/** True when the device advertises a non-empty `manufacturer`. Drives the
 *  direction-independent "missing sorts last" rule in `sortRows`. */
export function hasManufacturer(device: DeviceItemDevice): boolean {
  return metadataString(device.metadata, MANUFACTURER_KEY) !== null
}

/** Lowercased `manufacturer` sort key (empty when missing). */
function manufacturerSortKey(device: DeviceItemDevice): string {
  return (metadataString(device.metadata, MANUFACTURER_KEY) ?? '').toLowerCase()
}

/** Lowercased `model` sort key (empty when missing). */
function modelSortKey(device: DeviceItemDevice): string {
  return (metadataString(device.metadata, MODEL_KEY) ?? '').toLowerCase()
}

/** Ascending, case-insensitive comparator on `manufacturer` then `model`. The
 *  "missing manufacturer sorts last" rule is applied direction-independently by
 *  the caller (`sortRows`); this comparator only orders the values themselves. */
export function compareHardware(a: DeviceItemDevice, b: DeviceItemDevice): number {
  const byManufacturer = manufacturerSortKey(a).localeCompare(manufacturerSortKey(b))
  if (byManufacturer !== 0) return byManufacturer
  return modelSortKey(a).localeCompare(modelSortKey(b))
}
