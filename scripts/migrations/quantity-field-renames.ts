/**
 * The rename map of planning issue #260: a device value's field is named after
 * the QUANTITY it measures, never its unit (`power-meter.watts` → `power`).
 *
 * ONE module, imported by the offline migration
 * (`2026-10-27-quantity-field-names.ts`) and free to be imported by the code
 * that renames the caps. It has no dependency, so a script or a spec can load
 * it without building a package.
 *
 * Cap names are shared across vendors and field names are NOT unique across
 * caps (`battery.volts` and `power-meter.volts` are two different fields), so a
 * rename is always addressed as a `(cap, field)` pair — a lookup by field name
 * alone does not exist here.
 */

/** `old field name` → `new field name`, for one capability. */
export type CapFieldRenames = Readonly<Record<string, string>>

/** `capability name` → its renamed fields. */
export type QuantityFieldRenames = Readonly<Record<string, CapFieldRenames>>

/** The three appliance-like caps share one progress vocabulary. */
const APPLIANCE_PROGRESS: CapFieldRenames = {
  progressPercent: 'progress',
  remainingSeconds: 'remaining',
  delayedStartSeconds: 'delayedStart',
}

export const QUANTITY_FIELD_RENAMES: QuantityFieldRenames = {
  'power-meter': {
    watts: 'power',
    kwhTotal: 'energy',
    volts: 'voltage',
    amps: 'current',
    va: 'apparentPower',
  },
  battery: { percentage: 'level', volts: 'voltage' },
  brightness: { percentage: 'level' },
  'fan-control': { percentage: 'speed' },
  'humidity-sensor': { percent: 'humidity' },
  'temperature-sensor': { celsius: 'temperature' },
  'pressure-sensor': { hpa: 'pressure' },
  'ambient-light-sensor': { lux: 'illuminance' },
  'air-quality-sensor': { co2Ppm: 'co2', vocPpb: 'voc' },
  color: { mireds: 'colorTemperature' },
  'network-link': { rssiDbm: 'rssi', signalPercent: 'signal' },
  dishwasher: APPLIANCE_PROGRESS,
  'vacuum-control': APPLIANCE_PROGRESS,
  'lawn-mower-control': APPLIANCE_PROGRESS,
  'media-player': { positionMs: 'position', durationMs: 'duration' },
}

/**
 * Fields the code change DROPS. The migration deletes nothing for them: it only
 * counts how many stored references remain, so the operator sees the figure.
 */
export const DROPPED_FIELDS: Readonly<Record<string, readonly string[]>> = {
  presence: ['batteryPercent'],
}

export interface FieldRename {
  readonly cap: string
  readonly from: string
  readonly to: string
}

/** Every `(cap, old → new)` pair of the map, in declaration order. */
export function allRenames(): readonly FieldRename[] {
  return Object.entries(QUANTITY_FIELD_RENAMES).flatMap(([cap, fields]) =>
    Object.entries(fields).map(([from, to]) => ({ cap, from, to })),
  )
}

/** The new name of `cap.field`, or null when that pair is not renamed. */
export function renamedField(cap: string, field: string): string | null {
  const fields = QUANTITY_FIELD_RENAMES[cap]
  if (fields === undefined) return null
  const to = fields[field]
  return to === undefined ? null : to
}

/** True when `field` is the NEW name of a renamed field of `cap`. */
export function isNewFieldName(cap: string, field: string): boolean {
  const fields = QUANTITY_FIELD_RENAMES[cap]
  return fields !== undefined && Object.values(fields).includes(field)
}

/** True when `cap.field` is dropped by the code change. */
export function isDroppedField(cap: string, field: string): boolean {
  return DROPPED_FIELDS[cap]?.includes(field) ?? false
}

/** Does the stored name of `cap.field` matter to this migration at all? */
export function isTrackedField(cap: string, field: string): boolean {
  return (
    renamedField(cap, field) !== null || isNewFieldName(cap, field) || isDroppedField(cap, field)
  )
}

export interface SplitPath {
  /** The field: the first segment of a dotted or indexed path. */
  readonly field: string
  /** Everything after the field (`.value`, `[0]`, or ''). */
  readonly rest: string
}

/** A field path is a field name followed by an optional sub-path. */
export function splitFieldPath(path: string): SplitPath {
  const cut = path.search(/[.[]/)
  return cut === -1
    ? { field: path, rest: '' }
    : { field: path.slice(0, cut), rest: path.slice(cut) }
}

/** `cap`'s field path with its field renamed, or null when nothing changes. */
export function renamedFieldPath(cap: string, path: string): string | null {
  const { field, rest } = splitFieldPath(path)
  const to = renamedField(cap, field)
  return to === null ? null : `${to}${rest}`
}

export const HISTORY_KEY_PREFIX = 'cap:'

export interface HistoryKeyParts {
  readonly cap: string
  /** The field path after the cap name. */
  readonly path: string
}

/** `cap:<cap>.<path>` → its parts, or null for a key that is not a cap field. */
export function parseHistoryKey(key: string): HistoryKeyParts | null {
  if (!key.startsWith(HISTORY_KEY_PREFIX)) return null
  const body = key.slice(HISTORY_KEY_PREFIX.length)
  const dot = body.indexOf('.')
  if (dot <= 0 || dot === body.length - 1) return null
  return { cap: body.slice(0, dot), path: body.slice(dot + 1) }
}

/** The renamed history key of a series or metric, or null when it does not change. */
export function renamedHistoryKey(key: string): string | null {
  const parts = parseHistoryKey(key)
  if (parts === null) return null
  const path = renamedFieldPath(parts.cap, parts.path)
  return path === null ? null : `${HISTORY_KEY_PREFIX}${parts.cap}.${path}`
}

/** Every quoted JSON token a stored row can carry for a tracked field name. */
export function trackedFieldTokens(): readonly string[] {
  const names = new Set<string>()
  for (const fields of Object.values(QUANTITY_FIELD_RENAMES)) {
    for (const [from, to] of Object.entries(fields)) {
      names.add(from)
      names.add(to)
    }
  }
  for (const dropped of Object.values(DROPPED_FIELDS)) for (const name of dropped) names.add(name)
  return [...names].map((name) => `"${name}"`)
}
