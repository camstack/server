import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'
import { IconKeySchema } from '../device/icon-catalog.js'
import { readingMeta } from '../units/quantity.js'

/**
 * Heat pump status (D1026): the one main, READ-ONLY cap of a heat pump. Every
 * circuit the gateway reports is an entry of `circuits[]` — heating, hot water,
 * cooling or solar, any number — so no circuit needs a device of its own to be
 * seen. The settable parameters are typed methods of `heat-pump-control`; the
 * values they take and their limits (`allowed`, `min`, `max`, `step`) are read
 * from the gateway and carried here, never written in code.
 *
 * A value the gateway did not report is `null`, never `0` (D393). The COP is not
 * a field: it is computed from the two powers at read time
 * ({@link heatPumpInstantCop}).
 */

/** The kinds of circuit a heat pump serves. */
export const HEAT_PUMP_CIRCUIT_KINDS = ['heating', 'dhw', 'cooling', 'solar'] as const
export const HeatPumpCircuitKindSchema = z.enum(HEAT_PUMP_CIRCUIT_KINDS)
export type HeatPumpCircuitKind = z.infer<typeof HeatPumpCircuitKindSchema>

/** A setting that takes one of a list of values the gateway named. */
export const HeatPumpOptionSettingSchema = z.object({
  /** The active value. Null when the gateway did not answer. */
  value: z.string().nullable(),
  /** Values the gateway accepts, in its order. Empty = read-only here. */
  allowed: z.array(z.string()),
})
export type HeatPumpOptionSetting = z.infer<typeof HeatPumpOptionSettingSchema>

/** A numeric setting with the limits the gateway named. */
export const HeatPumpRangeSettingSchema = z.object({
  value: z.number().nullable(),
  min: z.number().nullable(),
  max: z.number().nullable(),
  step: z.number().nullable(),
})
export type HeatPumpRangeSetting = z.infer<typeof HeatPumpRangeSettingSchema>

export const HeatPumpCircuitSchema = z.object({
  /** Gateway id of the circuit (`hc1`, `dhw1`): the key of the series. */
  id: z.string().min(1),
  kind: HeatPumpCircuitKindSchema,
  label: z.string(),
  icon: IconKeySchema,
  /** Measured temperature of the circuit (room, tank, collector). */
  currentTemp: z.number().nullable().meta(readingMeta('temperature')),
  /** The setpoint in force now. */
  targetTemp: z.number().nullable().meta(readingMeta('temperature')),
  /** The operation mode in force (mirror of `operationMode.value`, for the series). */
  mode: z.string().nullable(),
  /** Whether the circuit is calling for heat right now. Null = unknown. */
  active: z.boolean().nullable(),
  operationMode: HeatPumpOptionSettingSchema.nullable(),
  /** Heating circuits: heat / cool / heatCool. */
  heatCoolMode: HeatPumpOptionSettingSchema.nullable(),
  /** Heating circuits: summer / winter changeover. */
  summerWinter: HeatPumpOptionSettingSchema.nullable(),
  comfortSetpoint: HeatPumpRangeSettingSchema.nullable(),
  ecoSetpoint: HeatPumpRangeSettingSchema.nullable(),
  maxFlowTemp: HeatPumpRangeSettingSchema.nullable(),
  /** Hot water: the temperature level (off / low / high / eco). */
  temperatureLevel: HeatPumpOptionSettingSchema.nullable(),
  /** Hot water: how long a charge lasts, minutes. */
  chargeDuration: HeatPumpRangeSettingSchema.nullable(),
  /** Hot water: whether an extra-hot-water charge is running. Null = no such surface. */
  extraHotWater: z.boolean().nullable(),
})
export type HeatPumpCircuit = z.infer<typeof HeatPumpCircuitSchema>

/** The independent system modes, each with its real values. A null mode = the gateway has none. */
export const HeatPumpSystemSchema = z.object({
  silent: HeatPumpOptionSettingSchema.nullable(),
  away: HeatPumpOptionSettingSchema.nullable(),
  additionalHeater: HeatPumpOptionSettingSchema.nullable(),
  holiday: HeatPumpOptionSettingSchema.nullable(),
})
export type HeatPumpSystem = z.infer<typeof HeatPumpSystemSchema>

export const HeatPumpPowerSchema = z.object({
  thermalW: z.number().nullable().meta(readingMeta('power')),
  electricalW: z.number().nullable().meta(readingMeta('power')),
  /** Compressor modulation, percent. */
  compressorPct: z.number().nullable().meta(readingMeta('percentage')),
})
export type HeatPumpPower = z.infer<typeof HeatPumpPowerSchema>

export const HeatPumpTemperaturesSchema = z.object({
  supply: z.number().nullable().meta(readingMeta('temperature')),
  return: z.number().nullable().meta(readingMeta('temperature')),
  outdoor: z.number().nullable().meta(readingMeta('temperature')),
})
export type HeatPumpTemperatures = z.infer<typeof HeatPumpTemperaturesSchema>

/** Lifetime meters, kWh: the energy of a period is computed at read time from their difference (D944). */
export const HeatPumpEnergySchema = z.object({
  thermalKwh: z.number().nullable().meta(readingMeta('energy')),
  electricalKwh: z.number().nullable().meta(readingMeta('energy')),
})
export type HeatPumpEnergy = z.infer<typeof HeatPumpEnergySchema>

export const HeatPumpStatusSchema = z.object({
  circuits: z.array(HeatPumpCircuitSchema),
  system: HeatPumpSystemSchema,
  power: HeatPumpPowerSchema,
  temperatures: HeatPumpTemperaturesSchema,
  energy: HeatPumpEnergySchema,
  /** Water pressure of the heating loop, bar. */
  waterPressureBar: z.number().nullable(),
  /** Compressor starts since commissioning. */
  starts: z.number().nullable(),
  /** Ms epoch when the slice was last read from the gateway. */
  lastFetchedAt: z.number(),
})
export type HeatPumpStatus = z.infer<typeof HeatPumpStatusSchema>

/**
 * The instantaneous COP: thermal over electrical power. Null unless BOTH powers
 * are known and the unit draws power — a missing reading is never a 0 or a
 * division by it (D393). Computed on every read; there is no stored value.
 */
export function heatPumpInstantCop(power: HeatPumpPower): number | null {
  const { thermalW, electricalW } = power
  if (thermalW === null || electricalW === null || electricalW <= 0) return null
  return thermalW / electricalW
}

export const heatPumpStatusCapability = {
  name: 'heat-pump-status',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.HeatPump],
  methods: {},
  status: {
    schema: HeatPumpStatusSchema,
    kind: 'push',
  },
  runtimeState: HeatPumpStatusSchema,
  /**
   * Runtime-state durability: **session** — a heat pump's gateway answers on the
   * next poll, so a restart that clears the slice loses nothing a reader needs
   * (the series are recorded). See `RuntimeStateDurability`.
   */
  durability: 'session',
  /**
   * History (D850, D917): `circuits[]` is a keyed array — one series per circuit and
   * field, named by the circuit's label. The mode is a state (D896); the energy
   * totals are lifetime counters, the kWh of a period is computed at read time (D944).
   * The COP is never recorded: it derives from the two powers.
   */
  history: {
    fields: {
      'power.thermalW': {
        kind: 'gauge',
        unit: 'W',
        deadband: 50,
        displayName: 'Thermal power',
      },
      'power.electricalW': {
        kind: 'gauge',
        unit: 'W',
        deadband: 50,
        displayName: 'Electrical power',
      },
      'power.compressorPct': {
        kind: 'gauge',
        unit: '%',
        deadband: 2,
        displayName: 'Compressor',
      },
      'temperatures.supply': {
        kind: 'gauge',
        unit: '°C',
        deadband: 0.5,
        displayName: 'Supply',
      },
      'temperatures.return': {
        kind: 'gauge',
        unit: '°C',
        deadband: 0.5,
        displayName: 'Return',
      },
      'temperatures.outdoor': {
        kind: 'gauge',
        unit: '°C',
        deadband: 0.5,
        displayName: 'Outdoor',
      },
      'energy.thermalKwh': {
        kind: 'counter',
        unit: 'kWh',
        displayName: 'Thermal energy',
      },
      'energy.electricalKwh': {
        kind: 'counter',
        unit: 'kWh',
        displayName: 'Electrical energy',
      },
    },
    items: {
      path: 'circuits',
      key: 'id',
      label: 'label',
      fields: {
        currentTemp: {
          kind: 'gauge',
          unit: '°C',
          deadband: 0.5,
          displayName: 'Temperature',
        },
        targetTemp: {
          kind: 'gauge',
          unit: '°C',
          minIntervalMs: 0,
          displayName: 'Setpoint',
        },
        mode: { kind: 'enum', displayName: 'Mode' },
      },
    },
  },
  volatileStateFields: ['lastFetchedAt'],
} as const satisfies CapabilityDefinition

export type IHeatPumpStatusProvider = InferProvider<typeof heatPumpStatusCapability>
