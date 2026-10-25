/**
 * The catalog↔form binding layer for the notification-rule condition editor.
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * The editor already CHOSE its widget from `descriptor.valueType`, but every
 * widget then wrote to a hardcoded `NcConditions` key — `case 'number'` wrote
 * `minDwellSeconds`, `case 'zoneIdList'` wrote `zonesExclude`, and so on. That
 * is only correct while each of those value types has exactly one condition in
 * the catalog. The moment a second `number` condition is added server-side the
 * old code renders it and silently edits a DIFFERENT rule field — a wrong rule
 * that looks authored, which is worse than a missing widget.
 *
 * So the target key is resolved from `descriptor.id` here, narrowed per value
 * type so the compiler still checks the write (no `as` cast). An id the editor
 * has no binding for is REPORTED in the UI rather than mapped to a neighbour:
 * the whole point of the catalog is that the server can add a condition, and
 * the failure mode has to be "the admin UI says it cannot author this yet",
 * never "the admin UI quietly wrote it into the wrong field".
 *
 * Group ORDER and placement are `notification-condition-layout.ts` (D690); a
 * group it does not list is appended there rather than dropped.
 */

import type { NcConditionDescriptor, NcConditions } from '@camstack/types'

/** A camera the rule can be scoped to (the `deviceIdList` widget source). */
export interface RuleCameraOption {
  readonly id: number
  readonly name: string
}

// ── Key narrowing, one set per valueType ────────────────────────────

/** A `descriptor.id` → condition-key type guard. */
export type ConditionKeyGuard<K extends string> = (id: string) => id is K

/** Build a guard from a literal key table, so the key union stays inferred. */
function keyGuard<T extends Readonly<Record<string, true>>>(
  table: T,
): ConditionKeyGuard<Extract<keyof T, string>> {
  return (id: string): id is Extract<keyof T, string> =>
    Object.prototype.hasOwnProperty.call(table, id)
}

const DEVICE_ID_LIST_KEYS = { devices: true } as const
export type DeviceIdListKey = keyof typeof DEVICE_ID_LIST_KEYS
export const isDeviceIdListKey: ConditionKeyGuard<DeviceIdListKey> = keyGuard(DEVICE_ID_LIST_KEYS)

/** D641: the device EXCLUSION — its own valueType, never bound to `devices`. */
const DEVICE_ID_EXCLUDE_LIST_KEYS = { devicesExclude: true } as const
export type DeviceIdExcludeListKey = keyof typeof DEVICE_ID_EXCLUDE_LIST_KEYS
export const isDeviceIdExcludeListKey: ConditionKeyGuard<DeviceIdExcludeListKey> = keyGuard(
  DEVICE_ID_EXCLUDE_LIST_KEYS,
)

const STRING_LIST_KEYS = {
  classes: true,
  classesExclude: true,
  labelEquals: true,
  identities: true,
  identitiesExclude: true,
  eventTypeTokens: true,
  sensorKinds: true,
} as const
export type StringListKey = keyof typeof STRING_LIST_KEYS
export const isStringListKey: ConditionKeyGuard<StringListKey> = keyGuard(STRING_LIST_KEYS)

const NUMBER01_KEYS = {
  minConfidence: true,
  minImportance: true,
  minLabelConfidence: true,
} as const
export type Number01Key = keyof typeof NUMBER01_KEYS
export const isNumber01Key: ConditionKeyGuard<Number01Key> = keyGuard(NUMBER01_KEYS)

const NUMBER_KEYS = { minDwellSeconds: true } as const
export type NumberKey = keyof typeof NUMBER_KEYS
export const isNumberKey: ConditionKeyGuard<NumberKey> = keyGuard(NUMBER_KEYS)

const SOURCE_SELECT_KEYS = { source: true } as const
export type SourceSelectKey = keyof typeof SOURCE_SELECT_KEYS
export const isSourceSelectKey: ConditionKeyGuard<SourceSelectKey> = keyGuard(SOURCE_SELECT_KEYS)

const CROSSING_SELECT_KEYS = { crossing: true } as const
export type CrossingSelectKey = keyof typeof CROSSING_SELECT_KEYS
export const isCrossingSelectKey: ConditionKeyGuard<CrossingSelectKey> =
  keyGuard(CROSSING_SELECT_KEYS)

const PACKAGE_PHASE_KEYS = { packagePhase: true } as const
export type PackagePhaseKey = keyof typeof PACKAGE_PHASE_KEYS
export const isPackagePhaseKey: ConditionKeyGuard<PackagePhaseKey> = keyGuard(PACKAGE_PHASE_KEYS)

const SENSOR_TRANSITION_KEYS = { sensorTransition: true } as const
export type SensorTransitionKey = keyof typeof SENSOR_TRANSITION_KEYS
export const isSensorTransitionKey: ConditionKeyGuard<SensorTransitionKey> =
  keyGuard(SENSOR_TRANSITION_KEYS)

const PLATE_MATCHER_KEYS = { plates: true } as const
export type PlateMatcherKey = keyof typeof PLATE_MATCHER_KEYS
export const isPlateMatcherKey: ConditionKeyGuard<PlateMatcherKey> = keyGuard(PLATE_MATCHER_KEYS)

const OCCUPANCY_KEYS = { occupancy: true } as const
export type OccupancyKey = keyof typeof OCCUPANCY_KEYS
export const isOccupancyKey: ConditionKeyGuard<OccupancyKey> = keyGuard(OCCUPANCY_KEYS)

/**
 * The occupancy schema's own defaults — RE-EXPORTED from `@camstack/types`.
 *
 * Both the WIDGET (what an untouched sub-field shows) and the CREATION PRESET
 * (what "New occupancy rule" seeds) have to author exactly these numbers, and
 * two copies of a default is how a preset starts writing a rule that does not
 * match what the editor then displays. The viewer authors the same preset, so
 * the numbers now live beside the kind model in
 * `@camstack/types` → `notification/rule-kinds.ts`, pinned there against
 * `NcOccupancyConditionSchema`'s own `.default(...)` clauses.
 */
export { NC_OCCUPANCY_DEFAULTS } from '@camstack/types'

const AUDIO_KEYS = { audio: true } as const
export type AudioKey = keyof typeof AUDIO_KEYS
export const isAudioKey: ConditionKeyGuard<AudioKey> = keyGuard(AUDIO_KEYS)

const SYSTEM_EVENT_KEYS = { systemEvent: true } as const
export type SystemEventKey = keyof typeof SYSTEM_EVENT_KEYS
export const isSystemEventKey: ConditionKeyGuard<SystemEventKey> = keyGuard(SYSTEM_EVENT_KEYS)

const DEVICE_STATE_KEYS = { deviceState: true } as const
export type DeviceStateKey = keyof typeof DEVICE_STATE_KEYS
export const isDeviceStateKey: ConditionKeyGuard<DeviceStateKey> = keyGuard(DEVICE_STATE_KEYS)

const SCENE_KEYS = { scene: true } as const
export type SceneKey = keyof typeof SCENE_KEYS
export const isSceneKey: ConditionKeyGuard<SceneKey> = keyGuard(SCENE_KEYS)

/**
 * Every condition key whose value is a `string[]` the widget switch reads.
 * `zones` / `zonesExclude` are not here: they are ONE scope field (D690).
 */
export type StringArrayConditionKey = StringListKey

// ── Readers ─────────────────────────────────────────────────────────

export function readStringList(
  conditions: NcConditions,
  key: StringArrayConditionKey,
): readonly string[] {
  const value = conditions[key]
  return Array.isArray(value) ? value : []
}

export function readNumber(
  conditions: NcConditions,
  key: Number01Key | NumberKey,
): number | undefined {
  const value = conditions[key]
  return typeof value === 'number' ? value : undefined
}

// ── Grouping ────────────────────────────────────────────────────────

/**
 * The only thing grouping reads. Deliberately structural and `string`-typed:
 * `NcConditionDescriptor['group']` is a CLOSED union of the groups that existed
 * when this bundle was compiled, while the catalog arrives at runtime from a
 * server that may be newer. Grouping must handle the value it is actually
 * given, not the one the local type says it can be.
 */
export interface GroupedDescriptor {
  readonly group: string
}

/** One rendered section: a heading plus the descriptors that belong to it. */
export interface ConditionGroup<T extends GroupedDescriptor = NcConditionDescriptor> {
  readonly id: string
  readonly label: string
  readonly descriptors: readonly T[]
}
