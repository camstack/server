import {
  DeviceRole,
  type BatteryStatus,
  type MeterStatus,
  type NumericSensorStatus,
  type PowerMeterStatus,
  type ReadingQuantity,
} from '@camstack/types'
import type { EnpalSnapshot } from './enpal-snapshot.js'
import { toBase } from './enpal-units.js'

/**
 * Where one value comes from: the first candidate key the box reported wins. `part` splits a
 * signed reading (grid power: negative is import) into the half a device owns.
 */
export interface PointSource {
  readonly key: string
  readonly part?: 'positive' | 'negative'
}

export interface Point {
  readonly quantity: ReadingQuantity
  readonly sources: readonly PointSource[]
}

interface SpecBase {
  readonly id: string
  readonly name: string
  readonly role: DeviceRole
}

/** Instantaneous power plus an optional lifetime energy counter (`power-meter`). */
export interface PowerMeterSpec extends SpecBase {
  readonly kind: 'power-meter'
  readonly power: Point
  readonly kwh?: Point
}

/** State of charge (`battery`) with the signed charge/discharge power on `power-meter`. */
export interface BatterySpec extends SpecBase {
  readonly kind: 'battery'
  readonly level: Point
  readonly capacity: Point
  readonly power: Point
  readonly voltage: Point
  readonly current: Point
}

/** A monotonic lifetime counter that no `power-meter` already carries (`meter`). */
export interface MeterSpec extends SpecBase {
  readonly kind: 'meter'
  readonly quantity: ReadingQuantity
  readonly value: Point
}

/** A reading no typed cap fits (`numeric-sensor`). */
export interface NumericSpec extends SpecBase {
  readonly kind: 'numeric'
  readonly quantity: ReadingQuantity
  readonly value: Point
}

export type EnpalSpec = PowerMeterSpec | BatterySpec | MeterSpec | NumericSpec

const point = (
  quantity: ReadingQuantity,
  ...sources: ReadonlyArray<string | PointSource>
): Point => ({
  quantity,
  sources: sources.map((s) => (typeof s === 'string' ? { key: s } : s)),
})

/**
 * What an Enpal box can show, by the dotted keys its InfluxDB and device page use (the
 * names follow the Home Assistant component's key table). A device is offered only when the
 * box reported at least one of its points, so a box without a heat pump has no heat-pump
 * devices. Lifetime energy rides `power-meter.energy` where a power reading sits beside it
 * and the `meter` cap where it does not (D944).
 */
export const ENPAL_SPECS: readonly EnpalSpec[] = [
  {
    kind: 'power-meter',
    id: 'pv',
    name: 'Production',
    role: DeviceRole.PowerSensor,
    power: point(
      'power',
      'Power.DC.Total',
      'Power.DC.Total.Calculated',
      'Power.DC.Total.Huawei',
      'Power.Production.Total',
    ),
    kwh: point('energy', 'Energy.Production.Total.Lifetime'),
  },
  {
    kind: 'battery',
    id: 'battery',
    name: 'Battery',
    role: DeviceRole.BatterySensor,
    level: point('percentage', 'Energy.Battery.Charge.Level'),
    capacity: point('energy', 'Energy.Battery.Capacity'),
    power: point('power', 'Power.Battery.Charge.Discharge'),
    voltage: point('voltage', 'Voltage.Battery'),
    current: point('current', 'Current.Battery'),
  },
  {
    kind: 'meter',
    id: 'battery-charged',
    name: 'Energy charged',
    role: DeviceRole.EnergySensor,
    quantity: 'energy',
    value: point('energy', 'Energy.Battery.Charge.Lifetime'),
  },
  {
    kind: 'meter',
    id: 'battery-discharged',
    name: 'Energy discharged',
    role: DeviceRole.EnergySensor,
    quantity: 'energy',
    value: point('energy', 'Energy.Battery.Discharge.Lifetime'),
  },
  {
    kind: 'power-meter',
    id: 'grid-import',
    name: 'Import',
    role: DeviceRole.PowerSensor,
    power: point(
      'power',
      'Grid.Import.Power.Total.Calculated',
      { key: 'Power.Grid.Export', part: 'negative' },
      { key: 'Power.Grid.Export.Calculated', part: 'negative' },
      { key: 'Power.Grid.Export.Huawei', part: 'negative' },
    ),
    kwh: point('energy', 'Energy.Grid.Import.Lifetime'),
  },
  {
    kind: 'power-meter',
    id: 'grid-export',
    name: 'Export',
    role: DeviceRole.PowerSensor,
    power: point(
      'power',
      { key: 'Power.Grid.Export', part: 'positive' },
      { key: 'Power.Grid.Export.Calculated', part: 'positive' },
      { key: 'Power.Grid.Export.Huawei', part: 'positive' },
    ),
    kwh: point('energy', 'Energy.Grid.Export.Lifetime'),
  },
  {
    kind: 'power-meter',
    id: 'house',
    name: 'Consumption',
    role: DeviceRole.PowerSensor,
    power: point('power', 'Power.Consumption.Total', 'Power.Consumption.AC'),
    kwh: point('energy', 'Energy.Consumption.Total.Lifetime'),
  },
  {
    kind: 'power-meter',
    id: 'heatpump',
    name: 'Consumption',
    role: DeviceRole.PowerSensor,
    power: point('power', 'Heatpump.Power.Consumption.Total'),
    kwh: point('energy', 'Heatpump.Energy.Consumption.Total.Lifetime'),
  },
  {
    kind: 'numeric',
    id: 'heatpump-hot-water',
    name: 'Hot water temperature',
    role: DeviceRole.TemperatureSensor,
    quantity: 'temperature',
    value: point('temperature', 'Heatpump.DomesticHotWater.Temperature'),
  },
  {
    kind: 'numeric',
    id: 'heatpump-outside',
    name: 'Outside temperature',
    role: DeviceRole.TemperatureSensor,
    quantity: 'temperature',
    value: point('temperature', 'Heatpump.Outside.Temperature'),
  },
  {
    kind: 'numeric',
    id: 'inverter-temperature',
    name: 'Inverter temperature',
    role: DeviceRole.TemperatureSensor,
    quantity: 'temperature',
    value: point('temperature', 'Temperature.Housing.Inside'),
  },
  {
    kind: 'numeric',
    id: 'battery-temperature',
    name: 'Temperature',
    role: DeviceRole.TemperatureSensor,
    quantity: 'temperature',
    value: point('temperature', 'Temperature.Battery'),
  },
  {
    kind: 'numeric',
    id: 'battery-health',
    name: 'Health',
    role: DeviceRole.NumericSensor,
    quantity: 'percentage',
    value: point('percentage', 'Battery.SOH'),
  },
]

export function findSpec(id: string): EnpalSpec | undefined {
  return ENPAL_SPECS.find((s) => s.id === id)
}

/** Cap names a spec's device registers. */
export function capsOfSpec(spec: EnpalSpec): readonly string[] {
  switch (spec.kind) {
    case 'power-meter':
      return ['power-meter']
    case 'battery':
      return ['battery', 'power-meter']
    case 'meter':
      return ['meter']
    case 'numeric':
      return ['numeric-sensor']
  }
}

function pointsOf(spec: EnpalSpec): readonly Point[] {
  switch (spec.kind) {
    case 'power-meter':
      return spec.kwh !== undefined ? [spec.power, spec.kwh] : [spec.power]
    case 'battery':
      return [spec.level, spec.power, spec.voltage, spec.current]
    case 'meter':
    case 'numeric':
      return [spec.value]
  }
}

type Resolved =
  | { readonly state: 'absent' }
  | { readonly state: 'value'; readonly value: number }
  | { readonly state: 'refused'; readonly why: string }

function resolve(target: Point, snapshot: EnpalSnapshot): Resolved {
  let refusal: string | null = null
  for (const source of target.sources) {
    const reading = snapshot.readings.get(source.key)
    if (reading === undefined) continue
    const converted = toBase(reading.value, reading.unit, target.quantity)
    if (!converted.ok) {
      refusal = `${source.key}: ${converted.reason} (unit ${reading.unit ?? 'none'})`
      continue
    }
    const v = converted.value
    const part = source.part
    return {
      state: 'value',
      value: part === 'positive' ? Math.max(0, v) : part === 'negative' ? Math.max(0, -v) : v,
    }
  }
  return refusal === null ? { state: 'absent' } : { state: 'refused', why: refusal }
}

/** Specs whose data the box reported: a refused point still counts, the device exists. */
export function availableSpecs(snapshot: EnpalSnapshot): readonly EnpalSpec[] {
  return ENPAL_SPECS.filter((spec) =>
    pointsOf(spec).some((p) => resolve(p, snapshot).state !== 'absent'),
  )
}

/** Per-box choices that change how readings are interpreted. */
export interface EnpalSliceOptions {
  readonly invertBatteryPower: boolean
}

/**
 * The cap slices of one device, from one snapshot. A reading that is absent or refused is
 * left out (an optional field) or `null` (a nullable one); it is never `0` (D393).
 */
export interface SpecSlices {
  readonly powerMeter?: PowerMeterStatus
  readonly battery?: BatteryStatus
  readonly meter?: MeterStatus
  readonly numeric?: NumericSensorStatus
  /** One line per reading the box sent that could not be converted. */
  readonly refusals: readonly string[]
}

function numberOf(r: Resolved): number | undefined {
  return r.state === 'value' ? r.value : undefined
}

function nullableOf(r: Resolved): number | null {
  return r.state === 'value' ? r.value : null
}

function refusalOf(r: Resolved): readonly string[] {
  return r.state === 'refused' ? [r.why] : []
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value))
}

/** State of charge: a percentage directly, or a kWh level over the capacity. */
function stateOfCharge(spec: BatterySpec, snapshot: EnpalSnapshot): Resolved {
  const reading = spec.level.sources
    .map((s) => snapshot.readings.get(s.key))
    .find((r) => r !== undefined)
  if (reading === undefined) return { state: 'absent' }
  if (reading.unit === '%' || reading.unit === undefined) {
    return { state: 'value', value: clampPercent(reading.value) }
  }
  const level = toBase(reading.value, reading.unit, 'energy')
  const capacity = resolve(spec.capacity, snapshot)
  if (!level.ok || capacity.state !== 'value' || capacity.value <= 0) {
    return {
      state: 'refused',
      why: `${reading.key}: no usable capacity for a ${reading.unit} level`,
    }
  }
  return { state: 'value', value: clampPercent((level.value / capacity.value) * 100) }
}

export function computeSlices(
  spec: EnpalSpec,
  snapshot: EnpalSnapshot,
  options: EnpalSliceOptions,
  now: number,
): SpecSlices {
  switch (spec.kind) {
    case 'power-meter': {
      const power = resolve(spec.power, snapshot)
      const kwh =
        spec.kwh !== undefined ? resolve(spec.kwh, snapshot) : ({ state: 'absent' } as const)
      const w = numberOf(power)
      const e = numberOf(kwh)
      return {
        ...(w !== undefined || e !== undefined
          ? {
              powerMeter: {
                ...(w !== undefined ? { power: w } : {}),
                ...(e !== undefined ? { energy: e } : {}),
                lastFetchedAt: now,
              },
            }
          : {}),
        refusals: [...refusalOf(power), ...refusalOf(kwh)],
      }
    }
    case 'battery': {
      const soc = stateOfCharge(spec, snapshot)
      const power = resolve(spec.power, snapshot)
      const voltage = resolve(spec.voltage, snapshot)
      const current = resolve(spec.current, snapshot)
      const sign = options.invertBatteryPower ? -1 : 1
      const w = numberOf(power)
      const v = numberOf(voltage)
      const a = numberOf(current)
      return {
        battery: {
          level: nullableOf(soc),
          charging: 'unknown',
          sleeping: false,
          lastUpdated: now,
        },
        ...(w !== undefined || v !== undefined || a !== undefined
          ? {
              powerMeter: {
                ...(w !== undefined ? { power: w * sign || 0 } : {}),
                ...(v !== undefined ? { voltage: v } : {}),
                ...(a !== undefined ? { current: a * sign || 0 } : {}),
                lastFetchedAt: now,
              },
            }
          : {}),
        refusals: [
          ...refusalOf(soc),
          ...refusalOf(power),
          ...refusalOf(voltage),
          ...refusalOf(current),
        ],
      }
    }
    case 'meter': {
      const value = resolve(spec.value, snapshot)
      return { meter: { value: nullableOf(value), lastFetchedAt: now }, refusals: refusalOf(value) }
    }
    case 'numeric': {
      const value = resolve(spec.value, snapshot)
      return {
        numeric: { value: nullableOf(value), lastFetchedAt: now },
        refusals: refusalOf(value),
      }
    }
  }
}
