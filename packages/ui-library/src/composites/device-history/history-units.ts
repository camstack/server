/**
 * The unit switch of a History chart: which units a chart of a given stored
 * unit may be shown in, which one the user's preferences pick, and the
 * conversion of its points. Stored numbers stay in the base unit (D944); only
 * the display moves.
 */
import {
  convertUnit,
  unitDimension,
  type DeviceDisplayOverride,
  type ReadingQuantity,
  type RoleDisplayDefault,
  type UnitDimension,
} from '@camstack/types'
import { resolveSensorDisplay } from '../../lib/resolve-sensor-display'
import type { TimePoint } from '../charts/chart-data'
import type { UnitPreferences } from '../../lib/unit-preferences'

/** The units worth offering per dimension, in the order a person reads them. */
const CHOICES: Readonly<Partial<Record<UnitDimension, readonly string[]>>> = {
  temperature: ['°C', '°F'],
  power: ['W', 'kW'],
  energy: ['Wh', 'kWh', 'MWh'],
  speed: ['m/s', 'km/h', 'mph'],
  pressure: ['hPa', 'inHg'],
  'precipitation-rate': ['mm/h', 'in/h'],
}

/**
 * A dimension with more than one stored base (length: `mm` for rain, `m` for a
 * distance driven) is keyed by the STORED unit — rain must never offer km.
 */
const CHOICES_BY_STORED_UNIT: Readonly<Record<string, readonly string[]>> = {
  mm: ['mm', 'in'],
  m: ['km', 'mi', 'm'],
}

/** The unit a stored-unit-keyed series opens in, per unit system. */
const STORED_UNIT_DEFAULTS: Readonly<
  Record<string, { readonly metric: string; readonly imperial: string }>
> = {
  mm: { metric: 'mm', imperial: 'in' },
  m: { metric: 'km', imperial: 'mi' },
}

/** The units a chart whose series is stored in `unit` can switch to; empty = no switch. */
export function chartUnitChoices(unit: string | null): readonly string[] {
  if (unit === null) return []
  const byStored = Object.hasOwn(CHOICES_BY_STORED_UNIT, unit)
    ? CHOICES_BY_STORED_UNIT[unit]
    : undefined
  if (byStored !== undefined) return byStored
  const dimension = unitDimension(unit)
  const choices = dimension === undefined ? undefined : CHOICES[dimension]
  if (choices === undefined || !choices.includes(unit)) return []
  return choices
}

const IMPERIAL: Readonly<Partial<Record<UnitDimension, string>>> = {
  speed: 'mph',
  pressure: 'inHg',
  'precipitation-rate': 'in/h',
}

/** The unit a chart opens in: the user's preference, else the stored unit. */
export function defaultChartUnit(unit: string, preferences: UnitPreferences): string {
  const choices = chartUnitChoices(unit)
  if (choices.length === 0) return unit
  const stored = Object.hasOwn(STORED_UNIT_DEFAULTS, unit) ? STORED_UNIT_DEFAULTS[unit] : undefined
  if (stored !== undefined)
    return preferences.system === 'imperial' ? stored.imperial : stored.metric
  const dimension = unitDimension(unit)
  const wanted =
    dimension === 'temperature'
      ? preferences.temperature === 'fahrenheit'
        ? '°F'
        : undefined
      : preferences.system === 'imperial' && dimension !== undefined
        ? IMPERIAL[dimension]
        : undefined
  return wanted !== undefined && choices.includes(wanted) ? wanted : unit
}

function convertOrNull(v: number | null | undefined, from: string, to: string): number | null {
  return v === null || v === undefined ? null : convertUnit(v, from, to)
}

/** Points (value and min/max band) converted `from` → `to`; the same array when nothing changes. */
export function convertPoints(
  points: readonly TimePoint[],
  from: string,
  to: string,
): readonly TimePoint[] {
  if (from === to) return points
  return points.map((p) => ({
    ...p,
    v: convertOrNull(p.v, from, to),
    ...(p.min === undefined ? {} : { min: convertOrNull(p.min, from, to) }),
    ...(p.max === undefined ? {} : { max: convertOrNull(p.max, from, to) }),
  }))
}

/** Dimensions whose unit follows the magnitude: 5000 W reads as 5 kW. */
const AUTO_SCALE: ReadonlySet<UnitDimension> = new Set<UnitDimension>(['power', 'energy'])

/** The largest choice the peak still reads as 1 or more in; the stored unit when none does. */
export function autoScaledUnit(base: string, peak: number | null): string {
  const dimension = unitDimension(base)
  if (peak === null || !Number.isFinite(peak) || dimension === undefined) return base
  if (!AUTO_SCALE.has(dimension)) return base
  let best = base
  for (const choice of chartUnitChoices(base)) {
    if (Math.abs(convertUnit(peak, base, choice)) >= 1) best = choice
  }
  return best
}

/** What decides a chart's unit besides the user's pick: the device's own display unit and the data. */
export interface ChartUnitContext {
  /** The device's display override and role default (`resolveSensorDisplay`). */
  readonly display?: DeviceDisplayOverride
  readonly roleDefault?: RoleDisplayDefault
  /** The capability the series belongs to (`perCap` overrides). */
  readonly capName?: string
  /** The quantity of the stored number; absent = no per-device unit applies. */
  readonly quantity?: ReadingQuantity
  /** The largest absolute value the chart draws, in the stored unit. */
  readonly peak?: number | null
}

export interface ChartUnitState {
  /** The unit shown; `null` when the stored unit is unknown — never a guess. */
  readonly unit: string | null
  readonly choices: readonly string[]
}

/** The unit the device itself asks for, when it differs from the stored one and the chart offers it. */
function deviceUnit(
  base: string,
  choices: readonly string[],
  preferences: UnitPreferences,
  context: ChartUnitContext,
): string | undefined {
  if (context.quantity === undefined) return undefined
  const { unit } = resolveSensorDisplay({
    ...(context.display === undefined ? {} : { display: context.display }),
    ...(context.roleDefault === undefined ? {} : { roleDefault: context.roleDefault }),
    ...(context.capName === undefined ? {} : { capName: context.capName }),
    quantity: context.quantity,
    unitPreferences: preferences,
  })
  return unit !== base && choices.includes(unit) ? unit : undefined
}

/**
 * What a chart stored in `base` shows and offers. In order: the user's pick, the
 * device's display unit, the user's unit preferences, then the magnitude (a power
 * in the thousands reads in kW). The axis, the tooltip and the readout all take it.
 */
export function chartUnitState(
  base: string | null,
  picked: string | null,
  preferences: UnitPreferences,
  context: ChartUnitContext = {},
): ChartUnitState {
  if (base === null) return { unit: null, choices: [] }
  const choices = chartUnitChoices(base)
  if (picked !== null && choices.includes(picked)) return { unit: picked, choices }
  const own = deviceUnit(base, choices, preferences, context)
  if (own !== undefined) return { unit: own, choices }
  const preferred = defaultChartUnit(base, preferences)
  if (preferred !== base) return { unit: preferred, choices }
  return { unit: autoScaledUnit(base, context.peak ?? null), choices }
}

/** A chart title that names its stored unit (`W`, `Power (W)`) names the shown one instead. */
export function titleInUnit(title: string, base: string | null, shown: string | null): string {
  if (base === null || shown === null || base === shown) return title
  if (title === base) return shown
  const suffix = `(${base})`
  return title.endsWith(suffix) ? `${title.slice(0, -suffix.length)}(${shown})` : title
}
