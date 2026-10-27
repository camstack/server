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

/** Where a field the code change DROPPED lives now (same device, another cap). */
export interface FieldHome {
  readonly cap: string
  readonly field: string
}

/**
 * Fields the code change DROPS from their cap and re-homes on another cap of
 * the same device. A stored runtime value is deleted (the owner repopulates it
 * from the new cap); a history series moves to the new cap's key when that
 * device has no series there yet and is dropped otherwise. References inside
 * compositions, recipes and rules are only counted: they name a field that no
 * longer exists and the operator re-points them.
 */
export const RELOCATED_FIELDS: Readonly<Record<string, Readonly<Record<string, FieldHome>>>> = {
  presence: { batteryPercent: { cap: 'battery', field: 'level' } },
}

export const DROPPED_FIELDS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  Object.entries(RELOCATED_FIELDS).map(([cap, fields]) => [cap, Object.keys(fields)]),
)

/** The home of a dropped `cap.field`, or null when it has none. */
export function relocatedField(cap: string, field: string): FieldHome | null {
  return RELOCATED_FIELDS[cap]?.[field] ?? null
}

/** A subset of one cap's field renames, read from the map so the names cannot drift. */
function pickRenames(cap: string, fields: readonly string[]): CapFieldRenames {
  const all = QUANTITY_FIELD_RENAMES[cap]
  if (all === undefined) throw new Error(`pickRenames: ${cap} is not in the rename map`)
  return Object.fromEntries(
    fields.map((field) => {
      const to = all[field]
      if (to === undefined) throw new Error(`pickRenames: ${cap}.${field} is not in the rename map`)
      return [field, to]
    }),
  )
}

/**
 * Method INPUT keys that follow a field rename: a stored call
 * `{ cap, method, args }` (automation and notification-rule actions, recipes,
 * scenes). Addressed by `(cap, method)` - `percentage` is a common word and is
 * renamed ONLY inside these calls.
 */
export const METHOD_ARG_RENAMES: Readonly<
  Record<string, Readonly<Record<string, CapFieldRenames>>>
> = {
  brightness: { setBrightness: pickRenames('brightness', ['percentage']) },
  'fan-control': { setPercentage: pickRenames('fan-control', ['percentage']) },
  'media-player': { seek: pickRenames('media-player', ['positionMs']) },
  color: { setColor: pickRenames('color', ['mireds']) },
}

/** An event payload whose keys follow a rename, `at` being the sub-object that holds them. */
export interface EventPayloadRename {
  readonly renames: CapFieldRenames
  /** The payload key holding a cap status object; absent when the payload itself carries the fields. */
  readonly at?: string
}

/** Event PAYLOAD keys that follow a field rename, addressed by `(cap, event)`. */
export const EVENT_PAYLOAD_RENAMES: Readonly<
  Record<string, Readonly<Record<string, EventPayloadRename>>>
> = {
  brightness: { onBrightnessChanged: { renames: pickRenames('brightness', ['percentage']) } },
  color: { onColorChanged: { renames: pickRenames('color', ['mireds']) } },
  battery: {
    // `{ deviceId, status: BatteryStatus }`: the status keys are the cap's own fields.
    onStatusChanged: { at: 'status', renames: pickRenames('battery', ['percentage', 'volts']) },
  },
}

/**
 * A provider's persisted config that is keyed by a cap's field names (the
 * adopted-device configs). `requires` lists sibling keys that identify the
 * config's shape: a string means the key holds that value, `true` means the
 * key must be present.
 */
export interface ProviderConfigSite {
  readonly key: string
  readonly cap: string
  readonly requires: Readonly<Record<string, string | true>>
}

export const PROVIDER_CONFIG_SITES: readonly ProviderConfigSite[] = [
  // Home Assistant adopted entities and container entities: `meterEntities: { power, energy, ... }`.
  { key: 'meterEntities', cap: 'power-meter', requires: {} },
  // MQTT discovery device: `meter: { power: <entityKey>, ... }`.
  { key: 'meter', cap: 'power-meter', requires: { brokerId: true, entityKey: true } },
  // ESPHome power-meter child: field -> board entity id, and field -> source unit.
  { key: 'slots', cap: 'power-meter', requires: { kind: 'power-meter', brokerId: true } },
  { key: 'slotUnits', cap: 'power-meter', requires: { kind: 'power-meter', brokerId: true } },
]

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

/** The history key a re-homed field's series moves to (`cap:presence.batteryPercent` → `cap:battery.level`), or null. */
export function relocatedHistoryKey(key: string): string | null {
  const parts = parseHistoryKey(key)
  if (parts === null) return null
  const home = relocatedField(parts.cap, parts.path)
  return home === null ? null : `${HISTORY_KEY_PREFIX}${home.cap}.${home.field}`
}

/**
 * Every name a stored row can carry for a tracked reference: field names (old
 * and new), method and event names, and the provider-config keys. A row that
 * mentions none of them cannot hold a reference, so it is skipped unparsed.
 */
export function trackedFieldTokens(): readonly string[] {
  const names = new Set<string>()
  for (const fields of Object.values(QUANTITY_FIELD_RENAMES)) {
    for (const [from, to] of Object.entries(fields)) {
      names.add(from)
      names.add(to)
    }
  }
  for (const dropped of Object.values(DROPPED_FIELDS)) for (const name of dropped) names.add(name)
  for (const methods of Object.values(METHOD_ARG_RENAMES)) {
    for (const [method, renames] of Object.entries(methods)) {
      names.add(method)
      for (const [from, to] of Object.entries(renames)) {
        names.add(from)
        names.add(to)
      }
    }
  }
  for (const events of Object.values(EVENT_PAYLOAD_RENAMES)) {
    for (const [event, rename] of Object.entries(events)) {
      names.add(event)
      for (const name of Object.keys(rename.renames)) names.add(name)
    }
  }
  for (const site of PROVIDER_CONFIG_SITES) names.add(site.key)
  return [...names]
}

export interface QualifiedText {
  /** `cap:` when the text is a history key, else ''. */
  readonly prefix: string
  readonly cap: string
  /** The field path after the cap name. */
  readonly path: string
}

const MAX_QUALIFIED_LENGTH = 120

/**
 * `<cap>.<path>` or `cap:<cap>.<path>` as one token, or null. A text with
 * whitespace is prose or code, never a reference. Cap names have no dot.
 */
export function parseQualifiedText(text: string): QualifiedText | null {
  if (text.length > MAX_QUALIFIED_LENGTH || /\s/.test(text)) return null
  const prefix = text.startsWith(HISTORY_KEY_PREFIX) ? HISTORY_KEY_PREFIX : ''
  const body = text.slice(prefix.length)
  const dot = body.indexOf('.')
  if (dot <= 0 || dot === body.length - 1) return null
  return { prefix, cap: body.slice(0, dot), path: body.slice(dot + 1) }
}

/** The qualified text with its field renamed, or null when nothing changes. */
export function renamedQualifiedText(text: string): string | null {
  const parts = parseQualifiedText(text)
  if (parts === null) return null
  const path = renamedFieldPath(parts.cap, parts.path)
  return path === null ? null : `${parts.prefix}${parts.cap}.${path}`
}
