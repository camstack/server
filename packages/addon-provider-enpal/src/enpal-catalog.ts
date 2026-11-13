import {
  DeviceRole,
  type EnumSensorStatus,
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

/**
 * The home storage: its state of charge is the sensor's READING (`numeric-sensor`, a percentage,
 * role {@link DeviceRole.BatterySensor}), with the signed charge/discharge power on `power-meter`.
 * Never the `battery` cap: that cap says the device RUNS on a battery, and a storage at 19 % is
 * not a device about to go flat (#522).
 */
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

/** A state label, as the box delivers it (`Running (0)`), on `enum-sensor`. */
export interface TextSpec extends SpecBase {
  readonly kind: 'text'
  readonly key: string
  /** The value is a clock (a certificate expiry), not a state: history does not learn it. */
  readonly timestamp?: boolean
}

export type EnpalSpec = PowerMeterSpec | BatterySpec | MeterSpec | NumericSpec | TextSpec

/**
 * The two meters the box both called "Consumption". English is the device
 * name (one string, like every other catalog entry); Italian is the addon
 * catalogue key `catalog.<id>.name`.
 */
export const ENPAL_CONSUMPTION_NAMES = {
  house: { en: 'House consumption', it: 'Consumo casa' },
  heatpump: { en: 'Heat pump consumption', it: 'Consumo pompa di calore' },
} as const

const point = (
  quantity: ReadingQuantity,
  ...sources: ReadonlyArray<string | PointSource>
): Point => ({
  quantity,
  sources: sources.map((s) => (typeof s === 'string' ? { key: s } : s)),
})

const numeric = (
  id: string,
  name: string,
  quantity: ReadingQuantity,
  key: string,
  role: DeviceRole = DeviceRole.NumericSensor,
): NumericSpec => ({
  kind: 'numeric',
  id,
  name,
  role,
  quantity,
  value: point(quantity, key),
})

const text = (id: string, name: string, key: string, timestamp = false): TextSpec => ({
  kind: 'text',
  id,
  name,
  role: timestamp ? DeviceRole.DateTimeSensor : DeviceRole.EnumSensor,
  key,
  ...(timestamp ? { timestamp: true } : {}),
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
    name: ENPAL_CONSUMPTION_NAMES.house.en,
    role: DeviceRole.PowerSensor,
    power: point('power', 'Power.Consumption.Total'),
    kwh: point('energy', 'Energy.Consumption.Total.Lifetime'),
  },
  {
    kind: 'power-meter',
    id: 'heatpump',
    name: ENPAL_CONSUMPTION_NAMES.heatpump.en,
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
  // Photovoltaic
  numeric(
    'pv-string-1-power',
    'String 1 power',
    'power',
    'Power.DC.String.1',
    DeviceRole.PowerSensor,
  ),
  numeric(
    'pv-string-2-power',
    'String 2 power',
    'power',
    'Power.DC.String.2',
    DeviceRole.PowerSensor,
  ),
  numeric(
    'pv-energy-day',
    'Production today',
    'energy',
    'Energy.Production.Total.Day',
    DeviceRole.EnergySensor,
  ),
  numeric(
    'pv-string-1-voltage',
    'String 1 voltage',
    'voltage',
    'Voltage.String.1',
    DeviceRole.VoltageSensor,
  ),
  numeric(
    'pv-string-2-voltage',
    'String 2 voltage',
    'voltage',
    'Voltage.String.2',
    DeviceRole.VoltageSensor,
  ),
  numeric(
    'pv-string-1-current',
    'String 1 current',
    'current',
    'Current.String.1',
    DeviceRole.CurrentSensor,
  ),
  numeric(
    'pv-string-2-current',
    'String 2 current',
    'current',
    'Current.String.2',
    DeviceRole.CurrentSensor,
  ),
  // Battery
  numeric(
    'battery-stored-energy',
    'Stored energy',
    'energy',
    'Energy.Battery.Charge.Load',
    DeviceRole.EnergySensor,
  ),
  numeric(
    'battery-charge-day',
    'Charged today',
    'energy',
    'Energy.Battery.Charge.Day',
    DeviceRole.EnergySensor,
  ),
  numeric(
    'battery-discharge-day',
    'Discharged today',
    'energy',
    'Energy.Battery.Discharge.Day',
    DeviceRole.EnergySensor,
  ),
  numeric(
    'battery-capacity',
    'Capacity',
    'energy',
    'Energy.Battery.Capacity',
    DeviceRole.EnergySensor,
  ),
  numeric(
    'battery-power-rating',
    'Maximum power rating',
    'power',
    'Battery.Power.Rating.Maximum',
    DeviceRole.PowerSensor,
  ),
  numeric('battery-level-max', 'Maximum charge level', 'percentage', 'Battery.ChargeLevel.Max'),
  numeric('battery-level-min', 'Minimum charge level', 'percentage', 'Battery.ChargeLevel.Min'),
  numeric(
    'battery-power-set',
    'Power setpoint',
    'power',
    'Power.Battery.Charge.Discharge.Set',
    DeviceRole.PowerSensor,
  ),
  numeric(
    'battery-charge-power-max',
    'Maximum charge power',
    'power',
    'Power.Battery.Charge.Max',
    DeviceRole.PowerSensor,
  ),
  numeric(
    'battery-discharge-power-max',
    'Maximum discharge power',
    'power',
    'Power.Battery.Discharge.Max',
    DeviceRole.PowerSensor,
  ),
  numeric(
    'battery-charge-current-max',
    'Maximum charge current',
    'current',
    'Current.Battery.Charge.Max',
    DeviceRole.CurrentSensor,
  ),
  numeric(
    'battery-discharge-current-max',
    'Maximum discharge current',
    'current',
    'Current.Battery.Discharge.Max',
    DeviceRole.CurrentSensor,
  ),
  // Grid
  numeric('grid-phase-a', 'Phase A power', 'power', 'Power.AC.Phase.A', DeviceRole.PowerSensor),
  numeric('grid-phase-b', 'Phase B power', 'power', 'Power.AC.Phase.B', DeviceRole.PowerSensor),
  numeric('grid-phase-c', 'Phase C power', 'power', 'Power.AC.Phase.C', DeviceRole.PowerSensor),
  numeric(
    'grid-import-day',
    'Imported today',
    'energy',
    'Energy.Grid.Import.Day',
    DeviceRole.EnergySensor,
  ),
  numeric(
    'grid-export-day',
    'Exported today',
    'energy',
    'Energy.Grid.Export.Day',
    DeviceRole.EnergySensor,
  ),
  numeric(
    'grid-voltage-a',
    'Phase A voltage',
    'voltage',
    'Voltage.Phase.A',
    DeviceRole.VoltageSensor,
  ),
  numeric(
    'grid-voltage-b',
    'Phase B voltage',
    'voltage',
    'Voltage.Phase.B',
    DeviceRole.VoltageSensor,
  ),
  numeric(
    'grid-voltage-c',
    'Phase C voltage',
    'voltage',
    'Voltage.Phase.C',
    DeviceRole.VoltageSensor,
  ),
  {
    kind: 'numeric',
    id: 'grid-frequency',
    name: 'Frequency',
    role: DeviceRole.NumericSensor,
    quantity: 'frequency',
    value: point('frequency', 'Frequency.Grid'),
  },
  numeric(
    'grid-feed-max',
    'Maximum feed-in power',
    'power',
    'Power.Grid.Maximum.Feed',
    DeviceRole.PowerSensor,
  ),
  // Home
  numeric(
    'house-energy-day',
    'Consumption today',
    'energy',
    'Energy.Consumption.Total.Day',
    DeviceRole.EnergySensor,
  ),
  // Inverter
  text('inverter-state', 'System state', 'Inverter.System.State'),
  text('inverter-ems-mode', 'EMS mode', 'Command.EMS.Mode'),
  numeric(
    'inverter-ac-power',
    'AC power',
    'power',
    'Power.Inverter.AC.Export',
    DeviceRole.PowerSensor,
  ),
  text('inverter-start-stop', 'Start/stop command', 'Command.Start.Stop'),
  text(
    'inverter-forcible-mode',
    'Forcible charge/discharge mode',
    'Mode.Forcible.Charge.Discharge',
  ),
  numeric(
    'inverter-power-rating',
    'Maximum power rating',
    'power',
    'Inverter.Power.Rating.Maximum',
    DeviceRole.PowerSensor,
  ),
  text('inverter-phase-type', 'Phase type', 'Type.Phase.Inverter'),
  text('inverter-modbus-rtu', 'Modbus RTU status', 'Inverter.Modbus.Health.Rtu.Status'),
  text('inverter-modbus-tcp', 'Modbus TCP status', 'Inverter.Modbus.Health.Tcp.Status'),
  // Heat pump
  text('heatpump-hot-water-mode', 'Hot water mode', 'Heatpump.DomesticHotWater.1.Mode'),
  text('heatpump-heating-mode', 'Heating circuit mode', 'Heatpump.HeatingCircuit.1.Mode'),
  text('heatpump-generator-state', 'Generator state', 'Heatpump.Generator.State.Running'),
  text('heatpump-heater-state', 'Electric heater state', 'Heatpump.ElectricHeater.State.Running'),
  text('heatpump-energy-management', 'Energy management state', 'Heatpump.EnergyManagement.State'),
  text('heatpump-power-desired', 'Power requested', 'Heatpump.Power.Desired.Enabled'),
  text('heatpump-pv-optimization', 'PV optimisation', 'Heatpump.Settings.PvOptimizationStatus'),
  numeric(
    'heatpump-power-min',
    'Generator minimum power',
    'power',
    'Heatpump.Generator.Power.Min',
    DeviceRole.PowerSensor,
  ),
  numeric(
    'heatpump-power-max',
    'Generator maximum power',
    'power',
    'Heatpump.Generator.Power.Max',
    DeviceRole.PowerSensor,
  ),
  text('heatpump-connection', 'Local connection', 'Heatpump.Local.ConnectionState'),
  // Enpal Box
  text('box-main-state', 'Main state', 'IoT.MainState'),
  numeric('box-cpu-load', 'CPU load', 'percentage', 'Cpu.Load'),
  numeric('box-memory-usage', 'Memory usage', 'percentage', 'Memory.Usage'),
  text('box-hardware-check', 'Hardware check', 'HW.Cronny.Result'),
  text('eebus-connection', 'Connection state', 'Eebus.ConnectionState'),
  text('eebus-discovery', 'Discovery state', 'Eebus.DiscoveryState'),
  text('eebus-cert-expiry', 'Certificate expiry', 'Eebus.CertExpiry', true),
  text('lte-state', 'LTE state', 'LTE.State'),
  text('lte-connection-type', 'Connection type', 'LTE.Connection.Type'),
  numeric('lte-quality', 'LTE quality', 'percentage', 'LTE.Quality'),
  numeric('lte-rsrp', 'RSRP', 'signal-level', 'LTE.RSRP'),
  numeric('lte-rsrq', 'RSRQ', 'signal-ratio', 'LTE.RSRQ'),
  numeric('lte-rssi', 'RSSI', 'signal-level', 'LTE.RSSI'),
  numeric('lte-snr', 'SNR', 'signal-ratio', 'LTE.SNR'),
  text('lte-failover', 'Failover result', 'LTE.Failover.Result'),
  text('lte-signal-check', 'Signal check', 'LTE.Cronny.Result'),
  text('wifi-state', 'Wi-Fi state', 'WiFi.State'),
  numeric(
    'data-lan-down',
    'LAN download this month',
    'count',
    'IoT.Data.Consumption.Lan.Down.Month',
  ),
  numeric('data-lan-up', 'LAN upload this month', 'count', 'IoT.Data.Consumption.Lan.Up.Month'),
  numeric(
    'data-lte-down',
    'LTE download this month',
    'count',
    'IoT.Data.Consumption.Lte.Down.Month',
  ),
  numeric('data-lte-up', 'LTE upload this month', 'count', 'IoT.Data.Consumption.Lte.Up.Month'),
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
      return ['numeric-sensor', 'power-meter']
    case 'meter':
      return ['meter']
    case 'numeric':
      return ['numeric-sensor']
    case 'text':
      return ['enum-sensor']
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
    case 'text':
      return []
  }
}

/** Every box key a spec reads (a text spec's key included). */
export function keysOfSpec(spec: EnpalSpec): readonly string[] {
  const keys = pointsOf(spec).flatMap((p) => p.sources.map((s) => s.key))
  if (spec.kind === 'text') return [spec.key]
  if (spec.kind === 'battery') return [...keys, ...spec.capacity.sources.map((s) => s.key)]
  return keys
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
    spec.kind === 'text'
      ? snapshot.texts.has(spec.key)
      : pointsOf(spec).some((p) => resolve(p, snapshot).state !== 'absent'),
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
  readonly meter?: MeterStatus
  readonly numeric?: NumericSensorStatus
  readonly text?: EnumSensorStatus
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
  return {
    state: 'value',
    value: clampPercent((level.value / capacity.value) * 100),
  }
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
        numeric: { value: nullableOf(soc), lastFetchedAt: now },
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
      return {
        meter: { value: nullableOf(value), lastFetchedAt: now },
        refusals: refusalOf(value),
      }
    }
    case 'numeric': {
      const value = resolve(spec.value, snapshot)
      return {
        numeric: { value: nullableOf(value), lastFetchedAt: now },
        refusals: refusalOf(value),
      }
    }
    case 'text': {
      // The label as delivered. A box that sent none leaves the slice alone: a text has no
      // null to say "unknown" with, and an invented empty state would read as a value.
      const value = snapshot.texts.get(spec.key)
      return {
        ...(value !== undefined
          ? {
              text: {
                value,
                ...(spec.timestamp === true ? { timestamp: true } : {}),
                lastFetchedAt: now,
              },
            }
          : {}),
        refusals: [],
      }
    }
  }
}
