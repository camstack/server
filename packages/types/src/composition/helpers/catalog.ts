/**
 * One catalog row per base reading a group helper can build (D944 §3).
 * Data, not a form default written into the block.
 */
import { DeviceRole, DeviceType } from '../../device/device-type.js'
import { baseUnitOf, type ReadingQuantity } from '../../units/quantity.js'
import type { AggregateEmpty } from './aggregate.js'
import {
  type AggregateReducer,
  BINARY_AGGREGATES,
  type BinaryAggregate,
  type GroupTemplateId,
  NUMERIC_AGGREGATES,
  type NumericAggregate,
} from './spec.js'

export interface HelperAccept {
  readonly cap: string
  readonly fieldPath: string
}

export interface HelperCompanion {
  readonly fieldPath: string
  readonly expr: string
}

export interface GroupTemplate {
  readonly id: GroupTemplateId
  readonly family: 'numeric' | 'binary'
  readonly summary: string
  readonly deviceType: DeviceType
  readonly role: DeviceRole
  /** Members are this one device type. */
  readonly memberDeviceType: DeviceType
  readonly outputCap: string
  readonly outputField: string
  /** Quantity of the output reading. `device` is chosen per numeric sensor. */
  readonly quantity: ReadingQuantity
  readonly baseUnit: string | undefined
  readonly aggregates: readonly AggregateReducer[]
  readonly defaultAggregate: AggregateReducer
  /**
   * No included member: `null` writes null and stays online; `omit` leaves an
   * optional key out and stays online; `offline` takes the device offline
   * rather than publishing false (D393).
   */
  readonly empty: AggregateEmpty
  readonly accept: readonly HelperAccept[]
  readonly companions: readonly HelperCompanion[]
}

const NOW: HelperCompanion = { fieldPath: 'lastFetchedAt', expr: 'now' }
const CHANGED: HelperCompanion = { fieldPath: 'lastChangedAt', expr: 'now' }

function numeric(input: {
  readonly id: GroupTemplateId
  readonly summary: string
  readonly role: DeviceRole
  readonly outputCap: string
  readonly outputField: string
  readonly quantity: ReadingQuantity
  readonly defaultAggregate: NumericAggregate
  readonly empty: AggregateEmpty
  readonly companions: readonly HelperCompanion[]
}): GroupTemplate {
  return {
    ...input,
    family: 'numeric',
    deviceType: DeviceType.Sensor,
    memberDeviceType: DeviceType.Sensor,
    baseUnit: baseUnitOf(input.quantity),
    aggregates: NUMERIC_AGGREGATES,
    accept: [{ cap: input.outputCap, fieldPath: input.outputField }],
  }
}

function binary(input: {
  readonly id: GroupTemplateId
  readonly summary: string
  readonly role: DeviceRole
  readonly outputCap: string
  readonly outputField: string
  readonly defaultAggregate: BinaryAggregate
  readonly accept: readonly HelperAccept[]
  readonly companions: readonly HelperCompanion[]
}): GroupTemplate {
  return {
    ...input,
    family: 'binary',
    deviceType: DeviceType.Sensor,
    memberDeviceType: DeviceType.Sensor,
    quantity: 'none',
    baseUnit: undefined,
    aggregates: BINARY_AGGREGATES,
    empty: 'offline',
  }
}

export const GROUP_TEMPLATES: readonly GroupTemplate[] = [
  numeric({
    id: 'temperature',
    summary:
      'Mean, median, min, max or sum of temperatures. Offline and unknown members are left out, never read as 0 °C.',
    role: DeviceRole.TemperatureSensor,
    outputCap: 'temperature-sensor',
    outputField: 'celsius',
    quantity: 'temperature',
    defaultAggregate: 'mean',
    empty: 'null',
    companions: [NOW],
  }),
  numeric({
    id: 'humidity',
    summary: 'Humidity in percent. Offline and unknown members are left out, never read as 0 %.',
    role: DeviceRole.HumiditySensor,
    outputCap: 'humidity-sensor',
    outputField: 'percent',
    quantity: 'humidity',
    defaultAggregate: 'mean',
    empty: 'null',
    companions: [NOW],
  }),
  numeric({
    id: 'pressure',
    summary:
      'Pressure in hectopascals. Offline and unknown members are left out, never read as 0 hPa.',
    role: DeviceRole.PressureSensor,
    outputCap: 'pressure-sensor',
    outputField: 'hpa',
    quantity: 'pressure',
    defaultAggregate: 'mean',
    empty: 'null',
    companions: [NOW],
  }),
  numeric({
    id: 'illuminance',
    summary: 'Illuminance in lux. Offline and unknown members are left out, never read as 0 lx.',
    role: DeviceRole.AmbientLightSensor,
    outputCap: 'ambient-light-sensor',
    outputField: 'lux',
    quantity: 'illuminance',
    defaultAggregate: 'mean',
    empty: 'null',
    companions: [NOW],
  }),
  numeric({
    id: 'power',
    summary:
      'Power in watts, summed by default. Nobody reporting omits the key rather than writing 0 W.',
    role: DeviceRole.PowerSensor,
    outputCap: 'power-meter',
    outputField: 'watts',
    quantity: 'power',
    defaultAggregate: 'sum',
    empty: 'omit',
    companions: [NOW],
  }),
  numeric({
    id: 'energy',
    summary:
      'Energy in kilowatt-hours, summed by default. Nobody reporting omits the key rather than writing 0 kWh.',
    role: DeviceRole.EnergySensor,
    outputCap: 'power-meter',
    outputField: 'kwhTotal',
    quantity: 'energy',
    defaultAggregate: 'sum',
    empty: 'omit',
    companions: [NOW],
  }),
  numeric({
    id: 'battery',
    summary:
      'Battery charge in percent. Offline and unknown members are left out, never read as 0 %.',
    role: DeviceRole.BatterySensor,
    outputCap: 'battery',
    outputField: 'percentage',
    quantity: 'percentage',
    defaultAggregate: 'mean',
    empty: 'null',
    companions: [
      { fieldPath: 'charging', expr: '"unknown"' },
      { fieldPath: 'sleeping', expr: 'false' },
      { fieldPath: 'lastUpdated', expr: 'now' },
    ],
  }),
  numeric({
    id: 'numeric',
    summary:
      'A numeric reading in the members’ shared quantity. Mixed quantities are refused. Nobody reporting publishes null, not 0.',
    role: DeviceRole.NumericSensor,
    outputCap: 'numeric-sensor',
    outputField: 'value',
    quantity: 'device',
    defaultAggregate: 'mean',
    empty: 'null',
    companions: [NOW],
  }),
  binary({
    id: 'motion',
    summary:
      'Any or all motion. Offline and unknown members are left out, never read as off. Nobody reporting takes the device offline.',
    role: DeviceRole.MotionSensor,
    outputCap: 'motion',
    outputField: 'detected',
    defaultAggregate: 'any',
    accept: [{ cap: 'motion', fieldPath: 'detected' }],
    companions: [
      { fieldPath: 'lastDetectedAt', expr: 'null' },
      { fieldPath: 'autoClearAfterMs', expr: 'null' },
    ],
  }),
  binary({
    id: 'contact',
    summary:
      'Any or all open contacts. Offline and unknown members are left out, never read as closed.',
    role: DeviceRole.ContactSensor,
    outputCap: 'contact',
    outputField: 'entryOpen',
    defaultAggregate: 'any',
    accept: [{ cap: 'contact', fieldPath: 'entryOpen' }],
    companions: [CHANGED],
  }),
  binary({
    id: 'leak',
    summary:
      'Any or all leak detections. Offline and unknown members are left out, never read as dry.',
    role: DeviceRole.LeakSensor,
    outputCap: 'flood',
    outputField: 'flooded',
    defaultAggregate: 'any',
    accept: [{ cap: 'flood', fieldPath: 'flooded' }],
    companions: [CHANGED],
  }),
  binary({
    id: 'smoke',
    summary:
      'Any or all smoke detections. Offline and unknown members are left out, never read as clear.',
    role: DeviceRole.SmokeSensor,
    outputCap: 'smoke',
    outputField: 'detected',
    defaultAggregate: 'any',
    accept: [{ cap: 'smoke', fieldPath: 'detected' }],
    companions: [CHANGED],
  }),
  binary({
    id: 'occupancy',
    summary:
      'Any or all of motion or binary sensors, published as a binary. Presence zones are not aggregated. Nobody reporting is offline, not off.',
    role: DeviceRole.BinarySensor,
    outputCap: 'binary',
    outputField: 'on',
    defaultAggregate: 'any',
    accept: [
      { cap: 'motion', fieldPath: 'detected' },
      { cap: 'binary', fieldPath: 'on' },
    ],
    companions: [CHANGED],
  }),
  binary({
    id: 'binary',
    summary:
      'Any or all generic binary sensors. Offline and unknown members are left out, never read as off.',
    role: DeviceRole.BinarySensor,
    outputCap: 'binary',
    outputField: 'on',
    defaultAggregate: 'any',
    accept: [{ cap: 'binary', fieldPath: 'on' }],
    companions: [CHANGED],
  }),
]

const BY_ID: ReadonlyMap<GroupTemplateId, GroupTemplate> = new Map(
  GROUP_TEMPLATES.map((template) => [template.id, template]),
)

export function groupTemplate(id: GroupTemplateId): GroupTemplate | null {
  return BY_ID.get(id) ?? null
}
