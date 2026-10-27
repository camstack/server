/**
 * The capability→HomeKit-service TABLE for non-camera devices.
 *
 * This is the whole coverage decision for the generic export path, and it is
 * deliberately a table rather than a `switch` on `DeviceType`. The doctrine is
 * the one the Home Assistant exporter already writes down: *coverage is decided
 * by a device's capabilities, not its type — restricting the picker by type is
 * what confined the previous exporter to cameras.* A `DeviceType` here is only
 * ever a UI filter (`HAP_EXPORTABLE_DEVICE_TYPES`) or an icon
 * (`ACCESSORY_CATEGORY_BY_TYPE`); it never decides whether something exports.
 *
 * The shape mirrors `CAP_ENTITY_MAP` in
 * `packages/addon-provider-homeassistant/src/ha-export/entity-catalog.ts` so
 * the two can be unified later — one row per capability, keyed by the cap name
 * exactly as it appears in `proxy.binding.entries[].capName`.
 *
 * ## Reading a status
 *
 * Every row parses the cap's OWN Zod status schema rather than duck-typing the
 * payload, and it `.pick()`s only the fields it reads: a provider that omits a
 * timestamp must not silence a sensor, and a provider that sends the wrong
 * shape must not write a garbage characteristic. A parse that fails yields no
 * updates, and the builder that owns the service logs the drop — silence reads
 * as "the sensor never changed".
 *
 * ## Tier
 *
 * Tier A, plus `alarm-panel`: the caps whose HomeKit service exists today and
 * needs no feature-dependent shape. `cover` still needs `cover-positionable`
 * and `climate-control` the dual-setpoint split; those are a separate task,
 * and adding a row here must never mean adding a service whose semantics this
 * file cannot fully honour.
 *
 * `alarm-panel` earned its row by answering the two questions that kept it
 * out: a target the panel would refuse is never offered (`availableModes` →
 * `validValues`, `security-target.ts`) and an arm a PIN-gated panel cannot
 * accept is refused out loud rather than attempted (`security-system.ts`).
 */

import {
  AmbientLightSensorStatusSchema,
  CarbonMonoxideStatusSchema,
  ContactStatusSchema,
  type DeviceProxy,
  DeviceType,
  FloodStatusSchema,
  HumiditySensorStatusSchema,
  MotionStatusSchema,
  PresenceStatusSchema,
  SmokeStatusSchema,
  TemperatureSensorStatusSchema,
} from '@camstack/types'
import { type Accessory, Categories, Characteristic, Service } from '@homebridge/hap-nodejs'

import type { BuilderContext, BuilderHandle } from '../../types.js'
import { batteryCharacteristicUpdates } from '../battery.js'
import { buildChildSwitch } from '../child-switch.js'
import { type CharacteristicUpdate, reader } from './characteristic-update.js'
import { buildLockMechanism } from './lock.js'
import { buildSecuritySystem } from './security-system.js'
import { buildSensorService } from './sensor-service.js'

/** A read-only sensor capability: one service, no writes, one subscription. */
export interface HapSensorSpec {
  /** Label when the accessory publishes more than one mapped service. */
  readonly label: string
  readonly addService: (accessory: Accessory, name: string, subtype: string) => Service
  readonly getStatus: (proxy: DeviceProxy) => Promise<unknown> | undefined
  readonly subscribe: (proxy: DeviceProxy, onValue: (value: unknown) => void) => (() => void) | null
  readonly read: (status: unknown) => readonly CharacteristicUpdate[]
}

/** What a row needs in order to build its service. */
export interface GenericServiceInput {
  readonly bctx: BuilderContext
  /** The label this service publishes — the device's own name when it is the
   *  accessory's only service, the row's `label` otherwise. */
  readonly name: string
  /** The device's own type. Used ONLY to choose between two HomeKit shapes for
   *  one capability (a siren's `brightness` is volume, not luminosity). */
  readonly deviceType: DeviceType
}

/** One row of the table. */
export interface HapCapServiceRow {
  /**
   * Every capability this row consumes. More than one when a single HomeKit
   * service covers them together — a `Lightbulb` is `switch` + `brightness`,
   * and publishing a second service for `brightness` would give iOS two
   * controls for one lamp.
   */
  readonly caps: readonly string[]
  /** What this service is called when the accessory publishes more than one. */
  readonly label: string
  readonly build: (input: GenericServiceInput) => Promise<BuilderHandle>
}

/** HomeKit's floor for `CurrentAmbientLightLevel`; 0 lux is out of range. */
const MIN_LUX = 0.0001

export const SENSOR_SPECS: Readonly<Record<string, HapSensorSpec>> = {
  contact: {
    label: 'Contact',
    addService: (accessory, name, subtype) =>
      accessory.addService(Service.ContactSensor, name, subtype),
    getStatus: (proxy) => proxy.contact?.getStatus({}),
    subscribe: (proxy, onValue) => proxy.state.contact?.subscribe(onValue) ?? null,
    read: reader(ContactStatusSchema.pick({ entryOpen: true }), (status) => [
      {
        characteristic: Characteristic.ContactSensorState,
        value: status.entryOpen
          ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
          : Characteristic.ContactSensorState.CONTACT_DETECTED,
      },
    ]),
  },
  motion: {
    label: 'Motion',
    addService: (accessory, name, subtype) =>
      accessory.addService(Service.MotionSensor, name, subtype),
    getStatus: (proxy) => proxy.motion?.getStatus({}),
    subscribe: (proxy, onValue) => proxy.state.motion?.subscribe(onValue) ?? null,
    read: reader(MotionStatusSchema.pick({ detected: true }), (status) => [
      { characteristic: Characteristic.MotionDetected, value: status.detected },
    ]),
  },
  presence: {
    label: 'Presence',
    addService: (accessory, name, subtype) =>
      accessory.addService(Service.OccupancySensor, name, subtype),
    getStatus: (proxy) => proxy.presence?.getStatus({}),
    subscribe: (proxy, onValue) => proxy.state.presence?.subscribe(onValue) ?? null,
    // `state` is HA's canonical vocabulary: `home` / `not_home` / any
    // user-defined zone name. Only `home` is occupancy — a person at `work` is
    // present somewhere, just not here.
    read: reader(PresenceStatusSchema.pick({ state: true }), (status) => [
      {
        characteristic: Characteristic.OccupancyDetected,
        value:
          status.state === 'home'
            ? Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
            : Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED,
      },
    ]),
  },
  smoke: {
    label: 'Smoke',
    addService: (accessory, name, subtype) =>
      accessory.addService(Service.SmokeSensor, name, subtype),
    getStatus: (proxy) => proxy.smoke?.getStatus({}),
    subscribe: (proxy, onValue) => proxy.state.smoke?.subscribe(onValue) ?? null,
    read: reader(SmokeStatusSchema.pick({ detected: true }), (status) => [
      {
        characteristic: Characteristic.SmokeDetected,
        value: status.detected
          ? Characteristic.SmokeDetected.SMOKE_DETECTED
          : Characteristic.SmokeDetected.SMOKE_NOT_DETECTED,
      },
    ]),
  },
  'carbon-monoxide': {
    label: 'Carbon monoxide',
    addService: (accessory, name, subtype) =>
      accessory.addService(Service.CarbonMonoxideSensor, name, subtype),
    getStatus: (proxy) => proxy.carbonMonoxide?.getStatus({}),
    subscribe: (proxy, onValue) => proxy.state.carbonMonoxide?.subscribe(onValue) ?? null,
    read: reader(CarbonMonoxideStatusSchema.pick({ detected: true }), (status) => [
      {
        characteristic: Characteristic.CarbonMonoxideDetected,
        value: status.detected
          ? Characteristic.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL
          : Characteristic.CarbonMonoxideDetected.CO_LEVELS_NORMAL,
      },
    ]),
  },
  flood: {
    label: 'Leak',
    addService: (accessory, name, subtype) =>
      accessory.addService(Service.LeakSensor, name, subtype),
    getStatus: (proxy) => proxy.flood?.getStatus({}),
    subscribe: (proxy, onValue) => proxy.state.flood?.subscribe(onValue) ?? null,
    read: reader(FloodStatusSchema.pick({ flooded: true }), (status) => [
      {
        characteristic: Characteristic.LeakDetected,
        value: status.flooded
          ? Characteristic.LeakDetected.LEAK_DETECTED
          : Characteristic.LeakDetected.LEAK_NOT_DETECTED,
      },
    ]),
  },
  'temperature-sensor': {
    label: 'Temperature',
    addService: (accessory, name, subtype) =>
      accessory.addService(Service.TemperatureSensor, name, subtype),
    getStatus: (proxy) => proxy.temperatureSensor?.getStatus({}),
    subscribe: (proxy, onValue) => proxy.state.temperatureSensor?.subscribe(onValue) ?? null,
    // The cap's field is `celsius`, which is also HomeKit's unit. A refused
    // sample is null (D944 §4, D393); HomeKit has no null, and 0 °C would be
    // a freezing reading nobody took, so the characteristic is left alone.
    read: reader(TemperatureSensorStatusSchema.pick({ temperature: true }), (status) =>
      status.temperature === null
        ? []
        : [{ characteristic: Characteristic.CurrentTemperature, value: status.temperature }],
    ),
  },
  'humidity-sensor': {
    label: 'Humidity',
    addService: (accessory, name, subtype) =>
      accessory.addService(Service.HumiditySensor, name, subtype),
    getStatus: (proxy) => proxy.humiditySensor?.getStatus({}),
    subscribe: (proxy, onValue) => proxy.state.humiditySensor?.subscribe(onValue) ?? null,
    read: reader(HumiditySensorStatusSchema.pick({ humidity: true }), (status) =>
      status.humidity === null
        ? []
        : [{ characteristic: Characteristic.CurrentRelativeHumidity, value: status.humidity }],
    ),
  },
  'ambient-light-sensor': {
    label: 'Light level',
    addService: (accessory, name, subtype) =>
      accessory.addService(Service.LightSensor, name, subtype),
    getStatus: (proxy) => proxy.ambientLightSensor?.getStatus({}),
    subscribe: (proxy, onValue) => proxy.state.ambientLightSensor?.subscribe(onValue) ?? null,
    read: reader(AmbientLightSensorStatusSchema.pick({ illuminance: true }), (status) =>
      status.illuminance === null
        ? []
        : [
            {
              characteristic: Characteristic.CurrentAmbientLightLevel,
              value: Math.max(MIN_LUX, status.illuminance),
            },
          ],
    ),
  },
}

/**
 * The `battery` row reads like a sensor but writes three characteristics from
 * one status, and the camera path publishes the SAME service from the same cap.
 * The derivation therefore lives once, in `battery.ts`, and both callers read
 * it from there.
 */
const BATTERY_SPEC: HapSensorSpec = {
  label: 'Battery',
  addService: (accessory, name, subtype) => accessory.addService(Service.Battery, name, subtype),
  getStatus: (proxy) => proxy.battery?.getStatus({}),
  subscribe: (proxy, onValue) => proxy.state.battery?.subscribe(onValue) ?? null,
  read: batteryCharacteristicUpdates,
}

function sensorRow(capName: string, spec: HapSensorSpec): HapCapServiceRow {
  return {
    caps: [capName],
    label: spec.label,
    build: ({ bctx, name }) => buildSensorService({ bctx, spec, name, subtype: capName }),
  }
}

/**
 * THE table. Order matters only for one thing: the first row that matches a
 * device decides the accessory's category when the device's own type does not.
 */
export const HAP_CAP_SERVICES: readonly HapCapServiceRow[] = [
  {
    // One service for both caps. `buildChildSwitch` already owns the
    // Switch-vs-Lightbulb decision and the reason it is gated on the device
    // type: a siren exposes `brightness` as alarm VOLUME, and a Lightbulb would
    // give iOS the wrong icon, the wrong scenes and the wrong Siri intents.
    caps: ['switch', 'brightness'],
    label: 'Power',
    build: ({ bctx, name, deviceType }) =>
      buildChildSwitch({ ...bctx, displayName: name }, 'switch', deviceType),
  },
  {
    caps: ['lock-control'],
    label: 'Lock',
    build: ({ bctx, name }) => buildLockMechanism({ ...bctx, displayName: name }),
  },
  {
    caps: ['alarm-panel'],
    label: 'Alarm',
    build: ({ bctx, name }) => buildSecuritySystem({ ...bctx, displayName: name }),
  },
  {
    caps: ['battery'],
    label: BATTERY_SPEC.label,
    build: ({ bctx, name }) =>
      buildSensorService({ bctx, spec: BATTERY_SPEC, name, subtype: 'battery' }),
  },
  ...Object.entries(SENSOR_SPECS).map(([capName, spec]) => sensorRow(capName, spec)),
]

/** Every capability the generic path can publish. */
export function hapExportableCapNames(): ReadonlySet<string> {
  return new Set(HAP_CAP_SERVICES.flatMap((row) => [...row.caps]))
}

/**
 * The rows a device's bound capabilities select, in table order.
 *
 * A row matches when ANY of its caps is bound: a lamp with `switch` but no
 * `brightness` is still a Lightbulb-shaped row, and the builder degrades on its
 * own.
 */
export function rowsForCaps(capNames: ReadonlySet<string>): readonly HapCapServiceRow[] {
  return HAP_CAP_SERVICES.filter((row) => row.caps.some((cap) => capNames.has(cap)))
}

/**
 * The HomeKit accessory category per camstack device type — the icon iOS Home
 * draws and nothing else. Absent = `OTHER`, which is a valid accessory that
 * simply gets the generic tile.
 *
 * This is NOT a coverage decision. `HAP_EXPORTABLE_DEVICE_TYPES` (in
 * `mappers/index.ts`) filters the picker; whether a device exports anything is
 * decided by `rowsForCaps`.
 */
const ACCESSORY_CATEGORY_BY_TYPE: Partial<Record<DeviceType, Categories>> = {
  [DeviceType.Switch]: Categories.SWITCH,
  [DeviceType.Light]: Categories.LIGHTBULB,
  [DeviceType.Siren]: Categories.SWITCH,
  [DeviceType.Lock]: Categories.DOOR_LOCK,
  [DeviceType.Sensor]: Categories.SENSOR,
  [DeviceType.Presence]: Categories.SENSOR,
  [DeviceType.AlarmPanel]: Categories.SECURITY_SYSTEM,
}

export function accessoryCategoryFor(deviceType: DeviceType): Categories {
  return ACCESSORY_CATEGORY_BY_TYPE[deviceType] ?? Categories.OTHER
}
