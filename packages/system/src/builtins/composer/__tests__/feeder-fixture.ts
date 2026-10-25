/**
 * The PetKit "Fresh Element Infinity" feeder as Home Assistant imports it (D663,
 * Task 14): the 27 REAL entities of HA device `8dec3b512fda40cbb8cd121c7a99f890`
 * with the state each had when read (read-only, 2026-09-28; the plan's
 * Decision 3 read of 2026-09-27 agrees on every state this spec depends on),
 * and the cap the HA domain mapping (`ha-domain-mapping.ts`) gives each child.
 *
 * Two facts of that mapping shape the customization:
 *   - `sensor.*` with NO device_class is an `enum-sensor` whatever its unit —
 *     the desiccant's `0` days arrives as the STRING `"0"`, which is why the
 *     composition reads it through `number(d)` (ruling B);
 *   - `binary_sensor.*_battery` is `battery_charging`, which `isBatteryEntity`
 *     does not match — the container registers NO native `battery`, so battery
 *     is an ADD (graft), like consumables.
 *
 * `BATTERY_CAM` is SYNTHETIC — not one of the 27: an HA container with one
 * `sensor.cam1_battery` (`device_class: battery`), so it registers `battery`
 * NATIVELY (`ha-container-device.ts`), the replace case the feeder cannot give.
 */
import {
  type CompositionSourceRef,
  DeviceType,
  FEEDER_EXAMPLE_ADDON_ID,
  feederExampleSources,
} from '@camstack/types'

/** The HA broker id the fixture adopts under; any id works — the stable ids embed it. */
export const BROKER_ID = 'b1'

export const HA = FEEDER_EXAMPLE_ADDON_ID

export const SOURCES = feederExampleSources(BROKER_ID)
export const FEEDER: CompositionSourceRef = SOURCES.feeder
export const DESICCANT_DAYS: CompositionSourceRef = SOURCES.desiccantDays
export const BATTERY_STATUS: CompositionSourceRef = SOURCES.batteryStatus
export const BATTERY_CHARGING: CompositionSourceRef = SOURCES.batteryCharging

/** The cap an HA child registers, as `mapHaEntityToCamStack` decides it for these entities. */
export type HaChildCap =
  | 'binary'
  | 'button'
  | 'control'
  | 'enum-sensor'
  | 'numeric-sensor'
  | 'switch'

export interface FeederEntity {
  readonly entityId: string
  /** `state.state` as read. */
  readonly state: string
  readonly deviceClass: string | null
  readonly unit: string | null
  readonly cap: HaChildCap
}

/** All 27, in HA's order. */
export const FEEDER_ENTITIES: readonly FeederEntity[] = [
  e('binary_sensor.freshelement_3_battery', 'off', 'battery_charging', null, 'binary'),
  e('binary_sensor.freshelement_3_food_level', 'off', 'problem', null, 'binary'),
  e('button.freshelement_3_call_pet', 'unknown', null, null, 'button'),
  e('button.freshelement_3_cancel_manual_feed', 'unknown', null, null, 'button'),
  e('button.freshelement_3_reset_desiccant', 'unknown', null, null, 'button'),
  e('number.freshelement_3_manual_feed', '4', 'weight', 'g', 'control'),
  e('number.freshelement_3_surplus', '50', 'weight', 'g', 'control'),
  e('number.freshelement_3_volume', '1', null, null, 'control'),
  e('select.freshelement_3_sound', 'Default', null, null, 'control'),
  e('sensor.freshelement_3_amount_eaten', '0', null, 'g', 'enum-sensor'),
  e('sensor.freshelement_3_battery_status', 'unavailable', null, null, 'enum-sensor'),
  e('sensor.freshelement_3_desiccant_days_remaining', '0', null, 'd', 'enum-sensor'),
  e('sensor.freshelement_3_dispensed', '0', null, 'g', 'enum-sensor'),
  e('sensor.freshelement_3_error', 'no_error', null, null, 'enum-sensor'),
  e('sensor.freshelement_3_food_in_bowl', '61', null, 'g', 'enum-sensor'),
  e('sensor.freshelement_3_planned', '0', null, 'g', 'enum-sensor'),
  e('sensor.freshelement_3_planned_dispensed', '0', null, 'g', 'enum-sensor'),
  e('sensor.freshelement_3_rssi', '-57', 'signal_strength', 'dBm', 'numeric-sensor'),
  e('sensor.freshelement_3_status', 'normal', null, null, 'enum-sensor'),
  e('sensor.freshelement_3_times_dispensed', '0', null, null, 'enum-sensor'),
  e('sensor.freshelement_3_times_eaten', '0', null, null, 'enum-sensor'),
  e('switch.freshelement_3_child_lock', 'on', null, null, 'switch'),
  e('switch.freshelement_3_do_not_disturb', 'off', null, null, 'switch'),
  e('switch.freshelement_3_indicator_light', 'on', null, null, 'switch'),
  e('switch.freshelement_3_surplus_control', 'off', null, null, 'switch'),
  e('switch.freshelement_3_system_notification_sound', 'off', null, null, 'switch'),
  e('switch.freshelement_3_voice_with_dispense', 'off', null, null, 'switch'),
]

function e(
  entityId: string,
  state: string,
  deviceClass: string | null,
  unit: string | null,
  cap: HaChildCap,
): FeederEntity {
  return { entityId, state, deviceClass, unit, cap }
}

/** A child's source ref: `<container stableId>-<entityId>` (`device-cap-proxy.ts` accessory children). */
export function childRef(entityId: string): CompositionSourceRef {
  return { addonId: HA, stableId: `${FEEDER.stableId}-${entityId}` }
}

export const FOOD: CompositionSourceRef = childRef('binary_sensor.freshelement_3_food_level')

/** SYNTHETIC: a container WITH a battery entity, so `battery` is native on it. */
export const BATTERY_CAM: CompositionSourceRef = {
  addonId: HA,
  stableId: `ha:${BROKER_ID}:dev:cam1`,
}

/** The container's types, as HA registers them: always `Container`; every child a `Sensor`-ish row. */
export const CONTAINER_TYPE = DeviceType.Container
export const CHILD_TYPE = DeviceType.Sensor

/**
 * The cap slice an HA child writes for its first state push — what the device
 * classes do (`HaBinarySensorDevice`, `HaEnumSensorDevice`): an `unavailable`
 * / `unknown` state is NOT pushed, so the child keeps its cold seed. `null` for
 * a child whose cap slice this spec never reads.
 */
export function firstPush(
  entity: FeederEntity,
  at: number,
): Readonly<Record<string, unknown>> | null {
  const unavailable = entity.state === 'unavailable' || entity.state === 'unknown'
  if (entity.cap === 'binary')
    return { on: !unavailable && entity.state === 'on', lastChangedAt: unavailable ? 0 : at }
  if (entity.cap === 'enum-sensor')
    return unavailable
      ? { value: '', lastFetchedAt: 0 }
      : { value: entity.state, lastFetchedAt: at }
  return null
}
