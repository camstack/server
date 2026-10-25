/**
 * The worked composed-device example: a ROOM. Temperature is the average of N
 * sensors, and occupancy is any motion within the last five minutes. It is the
 * slice-1 acceptance case and the template an author starts from (Phase 4
 * §4 item 4 asked for one).
 */
import { DeviceRole, DeviceType } from '../device/device-type.js'
import {
  type Composition,
  type CompositionBinding,
  type CompositionFromSource,
  CompositionSchema,
  type CompositionSourceRef,
} from './composition.js'

export const ROOM_OCCUPANCY_WINDOW_MS = 300_000

export const ROOM_EXAMPLE_TEMPERATURE_SOURCES: readonly CompositionSourceRef[] = [
  { addonId: 'provider-homeassistant', stableId: 'sensor.living_room_temperature' },
  { addonId: 'provider-homeassistant', stableId: 'sensor.sofa_temperature' },
  { addonId: 'provider-homeassistant', stableId: 'sensor.window_temperature' },
]

export const ROOM_EXAMPLE_MOTION_SOURCES: readonly CompositionSourceRef[] = [
  { addonId: 'provider-homeassistant', stableId: 'binary_sensor.living_room_motion' },
  { addonId: 'provider-homeassistant', stableId: 'binary_sensor.living_room_presence' },
]

export interface RoomExampleInput {
  readonly temperatureSources: readonly CompositionSourceRef[]
  readonly motionSources: readonly CompositionSourceRef[]
  readonly occupancyWindowMs: number
}

function from(source: CompositionSourceRef, cap: string, fieldPath: string): CompositionFromSource {
  return { kind: 'from', source, cap, fieldPath }
}

function named(
  prefix: string,
  sources: readonly CompositionSourceRef[],
  cap: string,
  fieldPath: string,
): Readonly<Record<string, CompositionBinding>> {
  return Object.fromEntries(sources.map((s, i) => [`${prefix}${i + 1}`, from(s, cap, fieldPath)]))
}

export function roomCompositionExample(input: RoomExampleInput): Composition {
  const t = named('t', input.temperatureSources, 'temperature-sensor', 'celsius')
  const f = named('f', input.temperatureSources, 'temperature-sensor', 'lastFetchedAt')
  const d = named('d', input.motionSources, 'motion', 'detected')
  const m = named('m', input.motionSources, 'motion', 'lastDetectedAt')
  const windows = Object.keys(m).map((name) => `within(${name}, ${input.occupancyWindowMs})`)
  return CompositionSchema.parse({
    target: {
      kind: 'new',
      type: DeviceType.Sensor,
      // Room primary readout is temperature; occupancy rides on `binary` as a
      // secondary surface. Without a role the device hero stays on
      // "Awaiting state…" forever even when slices are fresh.
      role: DeviceRole.TemperatureSensor,
    },
    features: [
      {
        kind: 'fields',
        cap: 'temperature-sensor',
        fields: {
          celsius: {
            kind: 'expression',
            expr: `round(avg(${Object.keys(t).join(', ')}), 1)`,
            bindings: t,
          },
          lastFetchedAt: {
            kind: 'expression',
            expr: `max(${Object.keys(f).join(', ')})`,
            bindings: f,
          },
        },
      },
      {
        kind: 'fields',
        cap: 'binary',
        fields: {
          on: {
            kind: 'expression',
            expr: `any(${[...Object.keys(d), ...windows].join(', ')})`,
            bindings: { ...d, ...m },
          },
          lastChangedAt: { kind: 'expression', expr: 'now', bindings: {} },
        },
      },
    ],
  })
}

/**
 * The slice-2 worked customization (D663): the PetKit "Fresh Element Infinity"
 * feeder as Home Assistant imports it — ONE `Container` with a child per entity
 * (`<container stableId>-<entityId>`), and NO native battery (its
 * `binary_sensor.*_battery` is `battery_charging`, which `isBatteryEntity` does
 * not match). The customization ADDS `consumables` (the desiccant) and
 * `battery`. It is the Task 14 acceptance case and the template slice 5's
 * presets start from.
 *
 * Every read names what the HA provider REALLY registers (read 2026-09-28):
 * the desiccant sensor has a unit (`d`) but no device_class, so HA hosts it as
 * an `enum-sensor` whose `value` is the raw STRING state — `number(d)` reads it,
 * and anything that is not a number is `null`, never 0 (D393). The battery
 * status sensor is an `enum-sensor` too (`unavailable` keeps its cold `''`, so
 * `percentage` is `null`). `charging` maps `battery_charging` off to
 * `'unknown'`, never `'none'`: off does not prove "on battery alone" (the
 * operator confirms the real semantics live).
 */
export const FEEDER_EXAMPLE_HA_DEVICE_ID = '8dec3b512fda40cbb8cd121c7a99f890'
export const FEEDER_EXAMPLE_ADDON_ID = 'provider-homeassistant'

/** The container and the three children the feeder customization reads, under one HA broker. */
export interface FeederExampleSources {
  readonly feeder: CompositionSourceRef
  /** `sensor.freshelement_3_desiccant_days_remaining` — `enum-sensor.value`, a numeric string. */
  readonly desiccantDays: CompositionSourceRef
  /** `sensor.freshelement_3_battery_status` — `enum-sensor.value`. */
  readonly batteryStatus: CompositionSourceRef
  /** `binary_sensor.freshelement_3_battery` (`battery_charging`) — `binary.on`. */
  readonly batteryCharging: CompositionSourceRef
}

/** The HA container's stableId (`ha-discovery.ts`) and a child's (`<container>-<entityId>`). */
export function feederExampleSources(brokerId: string): FeederExampleSources {
  const feeder: CompositionSourceRef = {
    addonId: FEEDER_EXAMPLE_ADDON_ID,
    stableId: `ha:${brokerId}:dev:${FEEDER_EXAMPLE_HA_DEVICE_ID}`,
  }
  const child = (entityId: string): CompositionSourceRef => ({
    addonId: FEEDER_EXAMPLE_ADDON_ID,
    stableId: `${feeder.stableId}-${entityId}`,
  })
  return {
    feeder,
    desiccantDays: child('sensor.freshelement_3_desiccant_days_remaining'),
    batteryStatus: child('sensor.freshelement_3_battery_status'),
    batteryCharging: child('binary_sensor.freshelement_3_battery'),
  }
}

export function feederCustomizationExample(sources: FeederExampleSources): Composition {
  const days = { d: from(sources.desiccantDays, 'enum-sensor', 'value') }
  return CompositionSchema.parse({
    target: { kind: 'existing', device: sources.feeder },
    features: [
      {
        kind: 'fields',
        cap: 'consumables',
        fields: {
          lastChangedAt: { kind: 'expression', expr: 'now', bindings: {} },
          lastFetchedAt: { kind: 'expression', expr: 'now', bindings: {} },
        },
        items: {
          desiccant: {
            label: 'Desiccant',
            fields: {
              'remaining.value': { kind: 'expression', expr: 'number(d)', bindings: days },
              'remaining.unit': { kind: 'expression', expr: '"days"', bindings: {} },
              status: {
                kind: 'expression',
                expr: 'number(d) == null ? null : (number(d) <= 0 ? "replace" : "ok")',
                bindings: days,
              },
            },
          },
        },
      },
      {
        kind: 'fields',
        cap: 'battery',
        fields: {
          percentage: {
            kind: 'expression',
            expr: 's == "low" ? 15 : (s == "normal" ? 100 : null)',
            bindings: { s: from(sources.batteryStatus, 'enum-sensor', 'value') },
          },
          binary: { kind: 'expression', expr: 'true', bindings: {} },
          charging: {
            kind: 'expression',
            expr: 'c ? "dc" : "unknown"',
            bindings: { c: from(sources.batteryCharging, 'binary', 'on') },
          },
          sleeping: { kind: 'expression', expr: 'false', bindings: {} },
          lastUpdated: { kind: 'expression', expr: 'now', bindings: {} },
        },
      },
    ],
  })
}
