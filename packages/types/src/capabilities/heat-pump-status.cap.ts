import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import type { CapabilityCustomizeSpec, ScalarCustomizeTarget } from './customize-spec.js'
import { DeviceType } from '../device/device-type.js'
import { IconKeySchema } from '../device/icon-catalog.js'
import { readingMeta } from '../units/quantity.js'
import { t } from '../device/cap-vocabulary/l10n.js'

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
  /** Gateway id of the circuit (`hc1`, `dhw1`, `sc1`). */
  id: z.string().min(1),
  /**
   * The registry id of the child device that owns this circuit's values
   * (climate child per heating circuit, water heater for the first hot-water
   * circuit): identity only, null when the circuit has no child. Its name is the
   * child's registry name (`label`); there is no second name.
   */
  deviceId: z.number().int().nonnegative().nullable(),
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
  /** Hot water: the temperature each level (low / high / eco) heats to, with the gateway's limits. */
  levelTemperatures: z.record(z.string(), HeatPumpRangeSettingSchema).nullable(),
  /** Heating circuits: the regulation strategy (`wdcoptimized`, `wdcsimplified`, `ISRC`, `vbh`). */
  controlType: HeatPumpOptionSettingSchema.nullable(),
  /** Solar: the temperature at the bottom of the storage tank. */
  tankBottomTemp: z.number().nullable().meta(readingMeta('temperature')),
  /** Solar: the storage limit the controller stops charging at (read-only). */
  maxCylinderTemp: z.number().nullable().meta(readingMeta('temperature')),
  /** Solar: the lifetime yield, kWh (the gateway reports Wh). */
  yieldKwh: z.number().nullable().meta(readingMeta('energy')),
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

/** What the heat source is asked for now: idle, central heating, hot water or frost protection. */
export const HEAT_PUMP_DEMANDS = ['idle', 'ch', 'dhw', 'frost'] as const
export const HeatPumpDemandSchema = z.enum(HEAT_PUMP_DEMANDS)
export type HeatPumpDemand = z.infer<typeof HeatPumpDemandSchema>

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
  /** Total working time of the heat source, seconds (a lifetime counter). */
  workingTime: z.number().nullable().meta(readingMeta('duration')),
  /** What the heat source is asked for now. Null = the gateway did not answer. */
  heatDemand: HeatPumpDemandSchema.nullable(),
  /** The kind of heat source the gateway names (`air_water`). Null = not answered. */
  heatSourceType: z.string().nullable(),
  /** Whether the compressor runs, when the gateway says so. Null = unknown. */
  compressorRunning: z.boolean().nullable(),
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

/**
 * The COP of a period: thermal over electrical energy (kWh) of the SAME period,
 * each a difference of the lifetime meters. Null unless both are known and the
 * unit drew energy — a missing reading is never a 0 or a division by it (D393).
 */
export function heatPumpPeriodCop(
  thermalKwh: number | null,
  electricalKwh: number | null,
): number | null {
  if (thermalKwh === null || electricalKwh === null || electricalKwh <= 0) return null
  return thermalKwh / electricalKwh
}

/** One reading of a lifetime kWh counter: when (ms epoch) and its value. */
export interface HeatPumpCounterSample {
  readonly at: number
  readonly value: number
}

/** The window of one counter step pair: when it starts and ends, and the energy between them. */
export interface HeatPumpHourWindow {
  readonly fromAt: number
  readonly toAt: number
  readonly deltaKwh: number
}

/** A pair of steps further apart than this says nothing about the hour just gone. */
export const HEAT_PUMP_HOUR_WINDOW_MS = 3 * 3_600_000

/**
 * The window between the last two DISTINCT values of a counter: each value counts
 * from the first reading that carried it, so a counter that repeats its value
 * between steps does not shorten the window. Null with fewer than two distinct
 * values, a counter that went backwards, or steps more than three hours apart.
 */
export function heatPumpHourWindow(
  samples: readonly HeatPumpCounterSample[],
): HeatPumpHourWindow | null {
  const sorted = [...samples].sort((a, b) => a.at - b.at)
  const steps: HeatPumpCounterSample[] = []
  for (const sample of sorted) {
    if (steps[steps.length - 1]?.value !== sample.value) steps.push(sample)
  }
  const to = steps[steps.length - 1]
  const from = steps[steps.length - 2]
  if (to === undefined || from === undefined) return null
  const spanMs = to.at - from.at
  if (spanMs <= 0 || spanMs > HEAT_PUMP_HOUR_WINDOW_MS || to.value <= from.value) return null
  return { fromAt: from.at, toAt: to.at, deltaKwh: to.value - from.value }
}

/**
 * The average power over the last counter step, W: delta kWh * 1000 / delta hours.
 * A marked average, never a measurement: the gateway publishes no power (D393).
 */
export function heatPumpHourAverage(samples: readonly HeatPumpCounterSample[]): number | null {
  const window = heatPumpHourWindow(samples)
  if (window === null) return null
  return (window.deltaKwh * 1000) / ((window.toAt - window.fromAt) / 3_600_000)
}

/** The value a counter held at `at`: the latest reading not after it. */
function counterAt(samples: readonly HeatPumpCounterSample[], at: number): number | null {
  let held: HeatPumpCounterSample | null = null
  for (const sample of samples) {
    if (sample.at <= at && (held === null || sample.at >= held.at)) held = sample
  }
  return held === null ? null : held.value
}

/**
 * The COP of the SAME hour the electrical average covers: the thermal counter's
 * difference over that exact window over the electrical one. Null when the
 * electrical window is unknown or the thermal counter does not cover it.
 */
export function heatPumpHourAverageCop(
  thermal: readonly HeatPumpCounterSample[],
  electrical: readonly HeatPumpCounterSample[],
): number | null {
  const window = heatPumpHourWindow(electrical)
  if (window === null) return null
  const start = counterAt(thermal, window.fromAt)
  const end = counterAt(thermal, window.toAt)
  if (start === null || end === null || end < start) return null
  return heatPumpPeriodCop(end - start, window.deltaKwh)
}

const HEAT_PUMP_CUSTOMIZE_DEVICE_TYPES = [DeviceType.HeatPump] as const

/** One electrical reading the operator may take from a device they pick, unit checked. */
function electricalTarget(id: string, path: string, unit: string): ScalarCustomizeTarget {
  return {
    id,
    cardinality: 'scalar',
    vocabulary: { cap: 'heat-pump-status' },
    deviceTypes: HEAT_PUMP_CUSTOMIZE_DEVICE_TYPES,
    apply: 'replace',
    path,
    sources: [{ kind: 'numeric', requiredUnit: unit, transforms: [{ kind: 'identity' }] }],
    sourceReport: { status: 'assignment-status' },
  }
}

const HEAT_PUMP_TARGETS: readonly ScalarCustomizeTarget[] = [
  electricalTarget('electrical-power', 'power.electricalW', 'W'),
  electricalTarget('electrical-energy', 'energy.electricalKwh', 'kWh'),
]

/**
 * Customize (D984, #476): a gateway that reports no instantaneous electrical
 * power (the cloud ones) or whose energy meter the operator trusts less than a
 * dedicated one lets the OPERATOR pick a device for `power.electricalW` and
 * `energy.electricalKwh` — a `replace` over a field listed in `overridable`,
 * nothing else. The replaced value IS the cap field, so the instant COP, the
 * hero pills and the history use it; nothing is linked by itself (D356), the
 * unit is checked, and a source that does not answer releases the field back to
 * the native reading (never a 0, D393).
 */
const heatPumpStatusCustomize = {
  version: 1,
  overridable: HEAT_PUMP_TARGETS.map((target) => ({ path: target.path, by: target.id })),
  targets: HEAT_PUMP_TARGETS,
} as const satisfies CapabilityCustomizeSpec

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
  customize: heatPumpStatusCustomize,
  /**
   * History (D850, D917): the heat source's own series only. A circuit's
   * temperature, setpoint and mode are recorded on its CHILD device (D1026 section 5),
   * never twice here. The demand is a state (D896); the energy totals and the
   * working time are lifetime counters, the kWh of a period is computed at read
   * time (D944). The COP is never recorded: it derives from the two powers.
   */
  history: {
    fields: {
      'power.thermalW': {
        group: 'power',
        kind: 'gauge',
        unit: 'W',
        deadband: 50,
        displayName: 'Thermal power',
      },
      'power.electricalW': {
        group: 'power',
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
        group: 'loop',
        kind: 'gauge',
        unit: '°C',
        deadband: 0.5,
        displayName: 'Supply',
      },
      'temperatures.return': {
        group: 'loop',
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
      workingTime: { kind: 'counter', unit: 's', displayName: 'Working time' },
      heatDemand: { kind: 'enum', displayName: 'Heat demand' },
    },
  },
  volatileStateFields: ['lastFetchedAt'],
  vocabulary: { noun: t('Heat pump', 'Pompa di calore'), order: 4000 },
} as const satisfies CapabilityDefinition

export type IHeatPumpStatusProvider = InferProvider<typeof heatPumpStatusCapability>
