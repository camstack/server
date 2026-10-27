import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import type { CapabilityCustomizeSpec } from './customize-spec.js'
import { DeviceType } from '../device/device-type.js'
import { readingMeta } from '../units/quantity.js'

/**
 * Multi-metric electrical meter. One slice can carry any combination
 * of instantaneous power (W), cumulative energy (kWh), voltage (V),
 * and current (A) — all fields optional so a single-metric source
 * (HA `sensor` with `device_class: power`) populates only what it
 * has and aggregators (energy dashboards, billing exports) compose
 * across providers without needing one cap per metric.
 *
 * Trade-off acknowledged: a HomeKit export that wants to surface
 * "power" and "energy" as separate services has to crack open the
 * slice and emit two characteristics from one cap. Worth it to avoid
 * exploding the cap catalog with `power-w` / `energy-kwh` /
 * `voltage-v` / `current-a` quartets that always travel together
 * in real-world devices.
 */
export const PowerMeterStatusSchema = z.object({
  /** Instantaneous power draw (watts). */
  power: z
    .number()
    .optional()
    .meta(readingMeta('power', { label: 'Power' })),
  /** Cumulative energy in kilowatt-hours since the meter was reset. */
  energy: z
    .number()
    .optional()
    .meta(readingMeta('energy', { label: 'Energy' })),
  /** Voltage (volts). */
  voltage: z
    .number()
    .optional()
    .meta(readingMeta('voltage', { label: 'Voltage' })),
  /** Current in amperes. */
  current: z
    .number()
    .optional()
    .meta(readingMeta('current', { label: 'Current' })),
  /** Apparent power in volt-amperes. */
  apparentPower: z.number().optional().meta(readingMeta('apparent-power')),
  /** Power factor (0..1) if reported. */
  powerFactor: z.number().min(0).max(1).optional().meta(readingMeta('ratio')),
  /** Ms epoch when the slice was last updated. */
  lastFetchedAt: z.number(),
})

export type PowerMeterStatus = z.infer<typeof PowerMeterStatusSchema>

/**
 * Loads that draw metered mains power (D951). The reading is a feature of the
 * device itself — a plug, a lamp, a fan, an air conditioner, a boiler, a
 * vacuum dock — not a separate sensor beside it. A `Sensor` stays: a clamp
 * meter or a standalone energy monitor IS the device. Cover, lock, valve,
 * camera and the like are left out: their draw is not what anyone meters.
 */
const POWER_METER_DEVICE_TYPES = [
  DeviceType.Sensor,
  DeviceType.Switch,
  DeviceType.Light,
  DeviceType.Fan,
  DeviceType.Climate,
  DeviceType.Thermostat,
  DeviceType.Humidifier,
  DeviceType.WaterHeater,
  DeviceType.MediaPlayer,
  DeviceType.Washer,
  DeviceType.Dryer,
  DeviceType.Dishwasher,
  DeviceType.Vacuum,
  DeviceType.LawnMower,
  DeviceType.PetFeeder,
] as const

/** Everything but a bare `Sensor`: a sensor that takes its reading from another sensor adds nothing. */
const POWER_METER_CUSTOMIZE_DEVICE_TYPES = POWER_METER_DEVICE_TYPES.filter(
  (type) => type !== DeviceType.Sensor,
)

/** One scalar target per reading; each is sourced from a device of its own (D951). */
function powerTarget(id: string, unit: string) {
  return {
    id,
    cardinality: 'scalar',
    vocabulary: { cap: 'power-meter', stateField: id },
    deviceTypes: POWER_METER_CUSTOMIZE_DEVICE_TYPES,
    apply: 'add',
    path: id,
    sources: [
      {
        kind: 'numeric',
        requiredUnit: unit,
        transforms: [{ kind: 'identity' }],
      },
    ],
    companions: [{ kind: 'clock', path: 'lastFetchedAt', when: 'always' }],
    sourceReport: { status: 'assignment-status' },
    advancedExpression: true,
  } as const
}

/** "Power and energy" extension: power, energy, voltage and current from other devices (D951). */
const powerMeterCustomize = {
  version: 1,
  targets: [
    powerTarget('power', 'W'),
    powerTarget('energy', 'kWh'),
    powerTarget('voltage', 'V'),
    powerTarget('current', 'A'),
  ],
} as const satisfies CapabilityCustomizeSpec

export const powerMeterCapability = {
  name: 'power-meter',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: POWER_METER_DEVICE_TYPES,
  methods: {},
  status: {
    schema: PowerMeterStatusSchema,
    kind: 'push',
  },
  runtimeState: PowerMeterStatusSchema,

  /**
   * Runtime-state durability: **restored** — as `numeric-sensor`; `energy` is an accumulator whose restored value is the baseline.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'restored',
  /**
   * History (D850): recorded series. Gauges are floored at 30 s; `energy` is the one monotonic meter (counter).
   */
  history: {
    fields: {
      power: { kind: 'gauge', unit: 'W', deadband: 1, minIntervalMs: 30000 },
      energy: { kind: 'counter', unit: 'kWh', deadband: 0.01, minIntervalMs: 60000 },
      voltage: { kind: 'gauge', unit: 'V', deadband: 1, minIntervalMs: 30000 },
      current: { kind: 'gauge', unit: 'A', deadband: 0.05, minIntervalMs: 30000 },
      apparentPower: { kind: 'gauge', unit: 'VA', deadband: 1, minIntervalMs: 30000 },
      powerFactor: { kind: 'gauge', unit: 'ratio', deadband: 0.01, minIntervalMs: 60000 },
    },
  },
  /** Clock fields: written, but excluded from the compare that decides
   *  whether persisting is worth a SQLite commit. */
  volatileStateFields: ['lastFetchedAt'],
  customize: powerMeterCustomize,
} as const satisfies CapabilityDefinition

export type IPowerMeterProvider = InferProvider<typeof powerMeterCapability>
